# Design Scalable API - Architecture

## System Overview

A high-performance API system designed to serve millions of users with low latency, high availability, and resilience. Core challenges involve horizontal scaling, traffic management, caching, and observability.

**Learning Goals:**
- Build horizontally scalable API services
- Design effective caching strategies
- Implement rate limiting and circuit breakers
- Create comprehensive observability

---

## Requirements

### Functional Requirements

1. **Serve**: Handle API requests efficiently
2. **Authenticate**: Verify user identity and permissions
3. **Rate Limit**: Protect from abuse
4. **Cache**: Reduce latency and database load
5. **Monitor**: Track performance and errors

### Non-Functional Requirements

- **Latency**: P99 < 100ms for cached, < 500ms for uncached
- **Throughput**: 100k+ requests per second
- **Availability**: 99.99% uptime
- **Scalability**: Linear scaling with instances

---

## High-Level Architecture

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

---

## Core Components

### 1. Load Balancer

**Traffic Distribution:**
```javascript
// NGINX configuration example
const nginxConfig = `
upstream api_servers {
    least_conn;  # Least connections algorithm

    server api1.internal:3000 weight=5 max_fails=3 fail_timeout=30s;
    server api2.internal:3000 weight=5 max_fails=3 fail_timeout=30s;
    server api3.internal:3000 weight=5 max_fails=3 fail_timeout=30s;

    keepalive 32;  # Keep connections open
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate /etc/ssl/certs/api.crt;
    ssl_certificate_key /etc/ssl/private/api.key;

    # Health check endpoint
    location /health {
        access_log off;
        proxy_pass http://api_servers;
    }

    location /api/ {
        proxy_pass http://api_servers;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Request-ID $request_id;

        # Timeouts
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;

        # Buffering
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }
}
`

// Health check implementation
class HealthChecker {
  async checkServer(server) {
    try {
      const response = await fetch(`http://${server}/health`, {
        timeout: 2000
      })

      if (response.ok) {
        const data = await response.json()
        return {
          healthy: true,
          latency: data.latency,
          load: data.load
        }
      }
      return { healthy: false }
    } catch (error) {
      return { healthy: false, error: error.message }
    }
  }

  async updateServerWeights(servers) {
    for (const server of servers) {
      const health = await this.checkServer(server.address)

      if (!health.healthy) {
        await this.markUnhealthy(server.address)
      } else {
        // Adjust weight based on load
        const weight = Math.max(1, 10 - Math.floor(health.load / 10))
        await this.setWeight(server.address, weight)
      }
    }
  }
}
```

### 2. API Server

**Request Handling:**
```javascript
const express = require('express')
const compression = require('compression')

class APIServer {
  constructor(config) {
    this.app = express()
    this.config = config
    this.setupMiddleware()
    this.setupRoutes()
  }

  setupMiddleware() {
    // Request ID for tracing
    this.app.use((req, res, next) => {
      req.id = req.headers['x-request-id'] || uuid()
      res.setHeader('X-Request-ID', req.id)
      next()
    })

    // Compression
    this.app.use(compression())

    // JSON parsing with size limit
    this.app.use(express.json({ limit: '1mb' }))

    // Request logging
    this.app.use(this.requestLogger.bind(this))

    // Rate limiting
    this.app.use(this.rateLimiter.middleware())

    // Authentication
    this.app.use('/api', this.authenticate.bind(this))

    // Error handling
    this.app.use(this.errorHandler.bind(this))
  }

  async requestLogger(req, res, next) {
    const start = Date.now()

    res.on('finish', () => {
      const duration = Date.now() - start

      this.metrics.recordRequest({
        method: req.method,
        path: req.route?.path || req.path,
        status: res.statusCode,
        duration,
        requestId: req.id
      })

      if (duration > 1000) {
        console.warn(`Slow request: ${req.method} ${req.path} took ${duration}ms`)
      }
    })

    next()
  }

  async authenticate(req, res, next) {
    const authHeader = req.headers.authorization

    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' })
    }

    try {
      const token = authHeader.replace('Bearer ', '')
      const user = await this.authService.verifyToken(token)
      req.user = user
      next()
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }

  errorHandler(err, req, res, next) {
    console.error(`Error handling ${req.method} ${req.path}:`, err)

    this.metrics.recordError({
      method: req.method,
      path: req.path,
      error: err.name,
      requestId: req.id
    })

    if (err.isOperational) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    res.status(500).json({ error: 'Internal server error', requestId: req.id })
  }
}
```

### 3. Caching Layer

**Multi-Level Cache:**
```javascript
class CacheService {
  constructor(redis) {
    this.redis = redis
    this.localCache = new Map()
    this.localCacheTTL = 5000 // 5 seconds for local cache
  }

  async get(key) {
    // Level 1: Local in-memory cache
    const local = this.localCache.get(key)
    if (local && local.expiry > Date.now()) {
      this.metrics.recordHit('local')
      return local.value
    }

    // Level 2: Redis cache
    const cached = await this.redis.get(key)
    if (cached) {
      const parsed = JSON.parse(cached)
      // Populate local cache
      this.localCache.set(key, {
        value: parsed,
        expiry: Date.now() + this.localCacheTTL
      })
      this.metrics.recordHit('redis')
      return parsed
    }

    this.metrics.recordMiss()
    return null
  }

  async set(key, value, ttlSeconds = 300) {
    // Set in Redis
    await this.redis.setex(key, ttlSeconds, JSON.stringify(value))

    // Set in local cache
    this.localCache.set(key, {
      value,
      expiry: Date.now() + Math.min(ttlSeconds * 1000, this.localCacheTTL)
    })
  }

  async invalidate(pattern) {
    // Invalidate Redis keys matching pattern
    const keys = await this.redis.keys(pattern)
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }

    // Clear local cache entries matching pattern
    const regex = new RegExp(pattern.replace('*', '.*'))
    for (const key of this.localCache.keys()) {
      if (regex.test(key)) {
        this.localCache.delete(key)
      }
    }
  }

  // Cache-aside pattern for database queries
  async getOrFetch(key, fetchFn, ttl = 300) {
    const cached = await this.get(key)
    if (cached !== null) {
      return cached
    }

    const value = await fetchFn()
    await this.set(key, value, ttl)
    return value
  }
}

// Usage in API
class UserAPI {
  async getUser(userId) {
    return this.cache.getOrFetch(
      `user:${userId}`,
      () => this.db.query('SELECT * FROM users WHERE id = $1', [userId]),
      600 // 10 minutes
    )
  }

  async updateUser(userId, data) {
    await this.db.query('UPDATE users SET ... WHERE id = $1', [userId])
    // Invalidate cache
    await this.cache.invalidate(`user:${userId}`)
  }
}
```

### 4. Rate Limiting

**Distributed Rate Limiter:**
```javascript
class RateLimiter {
  constructor(redis, config) {
    this.redis = redis
    this.config = config
  }

  middleware() {
    return async (req, res, next) => {
      const identifier = this.getIdentifier(req)
      const limit = this.getLimit(req)

      try {
        const result = await this.checkLimit(identifier, limit)

        res.setHeader('X-RateLimit-Limit', limit.requests)
        res.setHeader('X-RateLimit-Remaining', result.remaining)
        res.setHeader('X-RateLimit-Reset', result.resetAt)

        if (!result.allowed) {
          res.setHeader('Retry-After', result.retryAfter)
          return res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter: result.retryAfter
          })
        }

        next()
      } catch (error) {
        // Fail open on Redis errors
        console.error('Rate limiter error:', error)
        next()
      }
    }
  }

  getIdentifier(req) {
    // Use API key if authenticated, otherwise IP
    if (req.user?.apiKey) {
      return `key:${req.user.apiKey}`
    }
    return `ip:${req.ip}`
  }

  getLimit(req) {
    // Different limits based on tier
    const tier = req.user?.tier || 'anonymous'
    return this.config.limits[tier] || this.config.limits.anonymous
  }

  async checkLimit(identifier, limit) {
    const key = `ratelimit:${identifier}`
    const now = Date.now()
    const windowStart = now - limit.windowMs

    // Sliding window using sorted set
    const pipeline = this.redis.pipeline()
    pipeline.zremrangebyscore(key, 0, windowStart) // Remove old entries
    pipeline.zcard(key) // Count current entries
    pipeline.zadd(key, now, `${now}:${uuid()}`) // Add current request
    pipeline.expire(key, Math.ceil(limit.windowMs / 1000)) // Set expiry

    const results = await pipeline.exec()
    const currentCount = results[1][1]

    if (currentCount >= limit.requests) {
      // Get oldest entry to calculate retry-after
      const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES')
      const retryAfter = Math.ceil((parseInt(oldest[1]) + limit.windowMs - now) / 1000)

      return {
        allowed: false,
        remaining: 0,
        resetAt: Math.ceil((now + limit.windowMs) / 1000),
        retryAfter
      }
    }

    return {
      allowed: true,
      remaining: limit.requests - currentCount - 1,
      resetAt: Math.ceil((now + limit.windowMs) / 1000)
    }
  }
}

// Configuration
const rateLimitConfig = {
  limits: {
    anonymous: { requests: 100, windowMs: 60000 },    // 100/min
    free: { requests: 1000, windowMs: 60000 },        // 1000/min
    pro: { requests: 10000, windowMs: 60000 },        // 10k/min
    enterprise: { requests: 100000, windowMs: 60000 } // 100k/min
  }
}
```

### 5. Circuit Breaker

**Failure Protection:**
```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000
    this.halfOpenRequests = options.halfOpenRequests || 3

    this.state = 'closed'
    this.failures = 0
    this.successes = 0
    this.lastFailure = null
    this.halfOpenCount = 0
  }

  async execute(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.state = 'half-open'
        this.halfOpenCount = 0
      } else {
        throw new CircuitOpenError('Circuit breaker is open')
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.successes++
      if (this.successes >= this.halfOpenRequests) {
        this.state = 'closed'
        this.failures = 0
        this.successes = 0
      }
    } else {
      this.failures = Math.max(0, this.failures - 1)
    }
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()

    if (this.state === 'half-open') {
      this.state = 'open'
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'open'
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure
    }
  }
}

// Usage
class ExternalServiceClient {
  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000
    })
  }

  async callService(endpoint, data) {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
        timeout: 5000
      })

      if (!response.ok) {
        throw new Error(`Service error: ${response.status}`)
      }

      return response.json()
    })
  }
}
```

### 6. Observability

**Metrics & Tracing:**
```javascript
class MetricsService {
  constructor() {
    this.counters = new Map()
    this.histograms = new Map()
    this.gauges = new Map()
  }

  // Request metrics
  recordRequest(data) {
    const { method, path, status, duration } = data

    // Counter: total requests
    this.increment('http_requests_total', {
      method,
      path: this.normalizePath(path),
      status
    })

    // Histogram: request duration
    this.observe('http_request_duration_ms', duration, {
      method,
      path: this.normalizePath(path)
    })
  }

  recordError(data) {
    this.increment('http_errors_total', {
      method: data.method,
      path: this.normalizePath(data.path),
      error: data.error
    })
  }

  // Cache metrics
  recordHit(level) {
    this.increment('cache_hits_total', { level })
  }

  recordMiss() {
    this.increment('cache_misses_total')
  }

  // System metrics
  updateSystemMetrics() {
    const memUsage = process.memoryUsage()
    this.gauge('nodejs_heap_used_bytes', memUsage.heapUsed)
    this.gauge('nodejs_heap_total_bytes', memUsage.heapTotal)
    this.gauge('nodejs_external_memory_bytes', memUsage.external)

    const cpuUsage = process.cpuUsage()
    this.gauge('nodejs_cpu_user_seconds', cpuUsage.user / 1e6)
    this.gauge('nodejs_cpu_system_seconds', cpuUsage.system / 1e6)
  }

  // Prometheus format export
  async getMetrics() {
    let output = ''

    for (const [name, counter] of this.counters) {
      for (const [labels, value] of counter.entries()) {
        output += `${name}${this.formatLabels(labels)} ${value}\n`
      }
    }

    for (const [name, histogram] of this.histograms) {
      for (const [labels, values] of histogram.entries()) {
        const sorted = values.sort((a, b) => a - b)
        const count = sorted.length
        const sum = sorted.reduce((a, b) => a + b, 0)

        output += `${name}_count${this.formatLabels(labels)} ${count}\n`
        output += `${name}_sum${this.formatLabels(labels)} ${sum}\n`

        // Percentiles
        const p50 = sorted[Math.floor(count * 0.5)]
        const p90 = sorted[Math.floor(count * 0.9)]
        const p99 = sorted[Math.floor(count * 0.99)]

        output += `${name}{quantile="0.5",${this.formatLabels(labels, true)}} ${p50}\n`
        output += `${name}{quantile="0.9",${this.formatLabels(labels, true)}} ${p90}\n`
        output += `${name}{quantile="0.99",${this.formatLabels(labels, true)}} ${p99}\n`
      }
    }

    return output
  }

  normalizePath(path) {
    // Replace dynamic segments with placeholders
    return path
      .replace(/\/[0-9a-f-]{36}/g, '/:id')
      .replace(/\/\d+/g, '/:id')
  }
}

// Distributed tracing
class TracingService {
  async startSpan(name, parentSpan = null) {
    const span = {
      traceId: parentSpan?.traceId || uuid(),
      spanId: uuid(),
      parentSpanId: parentSpan?.spanId,
      name,
      startTime: Date.now(),
      tags: {},
      logs: []
    }

    return span
  }

  endSpan(span) {
    span.endTime = Date.now()
    span.duration = span.endTime - span.startTime

    // Send to tracing backend (Jaeger, Zipkin, etc.)
    this.reportSpan(span)
  }

  async reportSpan(span) {
    await fetch(this.tracingEndpoint, {
      method: 'POST',
      body: JSON.stringify(span)
    })
  }
}
```

### 7. Graceful Degradation

**Fallback Strategies:**
```javascript
class GracefulDegradation {
  constructor(cache, config) {
    this.cache = cache
    this.config = config
    this.degradedMode = false
  }

  async executeWithFallback(primaryFn, fallbackFn, cacheKey) {
    try {
      const result = await primaryFn()

      // Cache successful result for fallback
      if (cacheKey) {
        await this.cache.set(`fallback:${cacheKey}`, result, 3600)
      }

      return result
    } catch (error) {
      console.warn(`Primary function failed, trying fallback:`, error.message)

      // Try fallback function
      if (fallbackFn) {
        try {
          return await fallbackFn()
        } catch (fallbackError) {
          console.warn(`Fallback function failed:`, fallbackError.message)
        }
      }

      // Try cached data
      if (cacheKey) {
        const cached = await this.cache.get(`fallback:${cacheKey}`)
        if (cached) {
          console.log(`Using stale cached data for ${cacheKey}`)
          return { ...cached, _stale: true }
        }
      }

      throw error
    }
  }

  async handleDegradedMode(req, res, next) {
    if (this.degradedMode) {
      // Disable non-essential features
      req.degradedMode = true

      // Shorter timeouts
      req.timeout = this.config.degradedTimeout

      // Skip expensive operations
      if (this.isExpensiveEndpoint(req.path)) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          degraded: true
        })
      }
    }

    next()
  }

  isExpensiveEndpoint(path) {
    const expensive = ['/api/search', '/api/recommendations', '/api/analytics']
    return expensive.some(p => path.startsWith(p))
  }

  async enterDegradedMode(reason) {
    this.degradedMode = true
    console.warn(`Entering degraded mode: ${reason}`)

    // Notify operations
    await this.alerting.send({
      severity: 'warning',
      message: `API entering degraded mode: ${reason}`
    })
  }

  exitDegradedMode() {
    this.degradedMode = false
    console.info('Exiting degraded mode')
  }
}
```

---

## Database Schema

```sql
-- API keys
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  key_hash VARCHAR(64) NOT NULL, -- SHA-256 of key
  name VARCHAR(100),
  tier VARCHAR(20) DEFAULT 'free',
  scopes TEXT[],
  rate_limit_override JSONB,
  last_used TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Request logs (for analytics, debugging)
CREATE TABLE request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(36) NOT NULL,
  api_key_id UUID,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ip_address INET,
  user_agent TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Partition by time for efficient queries
CREATE INDEX idx_request_logs_time ON request_logs(created_at);
CREATE INDEX idx_request_logs_api_key ON request_logs(api_key_id, created_at);

-- Rate limit overrides
CREATE TABLE rate_limit_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier VARCHAR(200) NOT NULL, -- API key or IP
  requests_per_minute INTEGER NOT NULL,
  burst_limit INTEGER,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_rate_limit_identifier ON rate_limit_configs(identifier);
```

---

## Key Design Decisions

### 1. Stateless API Servers

**Decision**: Keep API servers stateless

**Rationale**:
- Easy horizontal scaling
- Simple deployment and rollback
- No sticky sessions needed
- Failure doesn't lose state

### 2. Redis for Rate Limiting

**Decision**: Centralized rate limiting in Redis

**Rationale**:
- Consistent limits across instances
- Atomic operations
- Fast performance
- TTL-based cleanup

### 3. Circuit Breaker per Dependency

**Decision**: Separate circuit breaker per external service

**Rationale**:
- Failure isolation
- Independent recovery
- Fine-grained control
- Clear metrics

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Load balancing | Least connections | Round robin | Better distribution |
| Rate limiting | Sliding window | Fixed window | Smoother limits |
| Caching | Two-level (local + Redis) | Redis only | Latency |
| Auth | JWT | Session | Stateless |
| Degradation | Feature flags | All or nothing | Flexibility |

---

## Cost Tradeoffs

This section documents cost-conscious decisions for local development and small-scale production deployments.

### Storage Tiering

| Storage Tier | Use Case | Local Dev Config | Cost Optimization |
|--------------|----------|------------------|-------------------|
| Hot (PostgreSQL) | Active API keys, recent logs | Default, no changes | Partition request_logs by week; drop partitions older than 30 days |
| Warm (MinIO/S3) | Archived logs, request payloads | `minio/data` volume | Compress JSON logs with gzip before storing (80% size reduction) |
| Cold (filesystem/glacier) | Compliance archives | `./archives/` directory | Export monthly summaries only; delete raw data after aggregation |

**Local Development Sizing:**
- PostgreSQL: 1GB data limit (sufficient for ~10M request log rows)
- MinIO: 5GB bucket limit for archived data
- Redis: 256MB maxmemory with `allkeys-lru` eviction policy

### Cache Sizing Guidelines

```yaml
# docker-compose.yml Redis configuration
redis:
  image: redis:7-alpine
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

**Cache allocation strategy:**
| Cache Purpose | Memory Budget | TTL | Eviction Priority |
|---------------|---------------|-----|-------------------|
| Session tokens | 50MB (~100k sessions) | 24 hours | Low (keep active users) |
| Rate limit counters | 30MB (~500k keys) | 1-5 minutes | Medium |
| API response cache | 150MB | 5-30 minutes | High (evict first) |
| Circuit breaker state | 1MB | N/A (no expiry) | Never evict |

**Monitoring cache efficiency:**
```bash
# Check Redis memory usage and hit rate
redis-cli INFO stats | grep -E "(keyspace_hits|keyspace_misses|used_memory_human)"

# Target: >90% hit rate for response cache, >95% for session cache
```

### Queue Retention (RabbitMQ)

| Queue | Max Length | Message TTL | Dead Letter Policy |
|-------|------------|-------------|-------------------|
| api.requests.async | 10,000 | 1 hour | Move to `api.requests.dlq` after 3 retries |
| api.notifications | 5,000 | 30 minutes | Discard (notifications are ephemeral) |
| api.analytics | 50,000 | 6 hours | Archive to MinIO on DLQ |

**Local development settings:**
```javascript
// RabbitMQ queue declaration with limits
await channel.assertQueue('api.requests.async', {
  durable: true,
  arguments: {
    'x-max-length': 10000,           // Reject oldest when full
    'x-message-ttl': 3600000,        // 1 hour in ms
    'x-dead-letter-exchange': 'dlx',
    'x-dead-letter-routing-key': 'api.requests.dlq'
  }
});
```

### Compute vs Storage Optimization

| Scenario | Compute-Heavy Approach | Storage-Heavy Approach | Recommendation |
|----------|------------------------|------------------------|----------------|
| Request analytics | Aggregate on read (slower queries, less storage) | Pre-compute hourly rollups (faster queries, more storage) | Pre-compute for local dev; simpler queries |
| Rate limit checks | Calculate from sorted set each time | Cache computed remaining quota | Compute fresh; Redis is fast enough |
| Response caching | Compress cached responses (CPU cost) | Store uncompressed (memory cost) | Compress; memory is the constraint |

**Cost summary for local development:**
- Prioritize memory efficiency (Redis, Node.js heap)
- Accept slightly higher CPU usage for compression
- Use aggressive TTLs to bound storage growth
- Prefer simple solutions over cost-optimized complexity

---

## Data Lifecycle Policies

### Retention and TTL Configuration

| Data Type | Hot Retention | Warm Retention | Archive/Delete |
|-----------|---------------|----------------|----------------|
| Request logs | 7 days in PostgreSQL | 30 days in MinIO (gzipped JSON) | Delete after 90 days |
| API keys | Indefinite (active) | N/A | Soft delete; hard delete after 1 year |
| Rate limit data | Redis TTL (1-5 min) | N/A | Auto-expires |
| Session tokens | Redis TTL (24 hours) | N/A | Auto-expires |
| Metrics/timeseries | 24 hours in memory | 30 days in Prometheus | Delete after 30 days |

### Automated Archival Process

**Daily archival job (runs at 2 AM local time):**

```javascript
// src/jobs/archive-logs.js
class LogArchiver {
  async run() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    // 1. Export old logs to JSONL format
    const logs = await this.db.query(`
      SELECT * FROM request_logs
      WHERE created_at < $1
      ORDER BY created_at
      LIMIT 100000
    `, [cutoffDate]);

    if (logs.rows.length === 0) return;

    // 2. Compress and upload to MinIO
    const filename = `logs/${cutoffDate.toISOString().split('T')[0]}.jsonl.gz`;
    const compressed = await gzip(logs.rows.map(JSON.stringify).join('\n'));
    await this.minio.putObject('archives', filename, compressed);

    // 3. Delete archived rows
    await this.db.query(`
      DELETE FROM request_logs
      WHERE id = ANY($1)
    `, [logs.rows.map(r => r.id)]);

    console.log(`Archived ${logs.rows.length} logs to ${filename}`);
  }
}
```

**Cron configuration for local development:**
```bash
# Add to crontab or use node-cron
# Run archival daily at 2 AM
0 2 * * * cd /path/to/scalable-api && node src/jobs/archive-logs.js

# Run partition maintenance weekly
0 3 * * 0 cd /path/to/scalable-api && node src/jobs/drop-old-partitions.js
```

### Partition Management (PostgreSQL)

```sql
-- Create partitioned request_logs table
CREATE TABLE request_logs (
  id UUID DEFAULT gen_random_uuid(),
  request_id VARCHAR(36) NOT NULL,
  api_key_id UUID,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ip_address INET,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create weekly partitions (run in migration or setup script)
CREATE TABLE request_logs_2025_w01 PARTITION OF request_logs
  FOR VALUES FROM ('2025-01-01') TO ('2025-01-08');

-- Auto-create future partitions (run weekly via cron)
-- src/db/migrations/create-partition.sql
DO $$
DECLARE
  partition_date DATE := date_trunc('week', NOW() + interval '1 week');
  partition_name TEXT := 'request_logs_' || to_char(partition_date, 'YYYY_"w"IW');
  start_date DATE := partition_date;
  end_date DATE := partition_date + interval '1 week';
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END $$;

-- Drop partitions older than 30 days (run weekly)
-- src/db/migrations/drop-old-partitions.sql
DO $$
DECLARE
  cutoff_date DATE := NOW() - interval '30 days';
  partition_record RECORD;
BEGIN
  FOR partition_record IN
    SELECT tablename FROM pg_tables
    WHERE tablename LIKE 'request_logs_%'
    AND schemaname = 'public'
  LOOP
    -- Extract date from partition name and drop if older than cutoff
    IF partition_record.tablename < 'request_logs_' || to_char(cutoff_date, 'YYYY_"w"IW') THEN
      EXECUTE 'DROP TABLE IF EXISTS ' || partition_record.tablename;
      RAISE NOTICE 'Dropped partition: %', partition_record.tablename;
    END IF;
  END LOOP;
END $$;
```

### Backfill and Replay Procedures

**Scenario 1: Replay archived logs for debugging**
```bash
#!/bin/bash
# scripts/replay-logs.sh

# Download and decompress archived logs
aws s3 cp s3://archives/logs/2025-01-15.jsonl.gz - | gunzip > /tmp/logs.jsonl

# Replay to a separate analysis table
psql $DATABASE_URL -c "CREATE TABLE IF NOT EXISTS request_logs_replay (LIKE request_logs);"

# Import using COPY
cat /tmp/logs.jsonl | jq -r '[.request_id, .method, .path, .status_code, .duration_ms, .created_at] | @csv' \
  | psql $DATABASE_URL -c "COPY request_logs_replay(request_id, method, path, status_code, duration_ms, created_at) FROM STDIN WITH CSV"
```

**Scenario 2: Backfill missing analytics data**
```javascript
// src/jobs/backfill-analytics.js
async function backfillHourlyStats(startDate, endDate) {
  const hours = [];
  let current = new Date(startDate);

  while (current < endDate) {
    const hourStart = new Date(current);
    const hourEnd = new Date(current.getTime() + 3600000);

    const stats = await db.query(`
      SELECT
        date_trunc('hour', created_at) as hour,
        COUNT(*) as total_requests,
        AVG(duration_ms) as avg_duration,
        COUNT(*) FILTER (WHERE status_code >= 500) as error_count
      FROM request_logs
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1
    `, [hourStart, hourEnd]);

    if (stats.rows[0]) {
      await db.query(`
        INSERT INTO hourly_stats (hour, total_requests, avg_duration_ms, error_count)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (hour) DO UPDATE SET
          total_requests = EXCLUDED.total_requests,
          avg_duration_ms = EXCLUDED.avg_duration_ms,
          error_count = EXCLUDED.error_count
      `, [stats.rows[0].hour, stats.rows[0].total_requests,
          stats.rows[0].avg_duration, stats.rows[0].error_count]);
    }

    current = hourEnd;
  }
}
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development (2-3 instances):**

1. **Blue-Green Deployment Simulation**
   ```bash
   # Step 1: Start new version on alternate ports
   PORT=3011 npm run dev:server1 &  # New version
   PORT=3012 npm run dev:server2 &  # New version

   # Step 2: Update load balancer config to point to new ports
   # Edit backend/load-balancer/src/config.js
   # Change: servers: ['localhost:3001', 'localhost:3002']
   # To:     servers: ['localhost:3011', 'localhost:3012']

   # Step 3: Reload load balancer (send SIGHUP or restart)
   kill -HUP $(pgrep -f "load-balancer")

   # Step 4: Verify new version is serving traffic
   curl http://localhost:3000/api/v1/health | jq '.version'

   # Step 5: Stop old instances
   kill $(pgrep -f "PORT=3001")
   kill $(pgrep -f "PORT=3002")
   ```

2. **Rolling Deployment (zero-downtime)**
   ```bash
   #!/bin/bash
   # scripts/rolling-deploy.sh

   SERVERS=("3001" "3002" "3003")

   for PORT in "${SERVERS[@]}"; do
     echo "Deploying to server on port $PORT..."

     # Remove from load balancer
     curl -X POST "http://localhost:3000/admin/servers/$PORT/drain"
     sleep 5  # Wait for in-flight requests

     # Restart with new code
     kill $(pgrep -f "PORT=$PORT")
     PORT=$PORT npm run dev:server &
     sleep 3  # Wait for startup

     # Health check
     until curl -s "http://localhost:$PORT/health" | grep -q "ok"; do
       sleep 1
     done

     # Add back to load balancer
     curl -X POST "http://localhost:3000/admin/servers/$PORT/enable"
     echo "Server $PORT deployed successfully"
   done
   ```

3. **Canary Deployment**
   ```javascript
   // Load balancer canary configuration
   const servers = [
     { address: 'localhost:3001', weight: 90, version: 'stable' },
     { address: 'localhost:3002', weight: 90, version: 'stable' },
     { address: 'localhost:3003', weight: 10, version: 'canary' }  // 5% traffic
   ];

   // Monitor canary metrics for 15 minutes before proceeding
   // Check: error rate, latency p99, circuit breaker trips
   ```

### Schema Migration Procedures

**Migration file structure:**
```
backend/src/db/migrations/
  001_initial_schema.sql
  002_add_api_keys.sql
  003_partition_request_logs.sql
  004_add_rate_limit_configs.sql
```

**Migration runner:**
```javascript
// src/db/migrate.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get applied migrations
  const { rows: applied } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const appliedVersions = new Set(applied.map(r => r.version));

  // Find pending migrations
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0]);
    if (appliedVersions.has(version)) continue;

    console.log(`Applying migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
        [version, file]
      );
      await client.query('COMMIT');
      console.log(`Applied: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to apply ${file}:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('Migrations complete');
}

migrate().catch(console.error);
```

**Safe migration practices:**
```sql
-- 003_partition_request_logs.sql
-- Step 1: Create new partitioned table (non-blocking)
CREATE TABLE request_logs_new (
  LIKE request_logs INCLUDING ALL
) PARTITION BY RANGE (created_at);

-- Step 2: Create initial partition
CREATE TABLE request_logs_new_current PARTITION OF request_logs_new
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- Step 3: Copy data in batches (run separately, not in migration)
-- INSERT INTO request_logs_new SELECT * FROM request_logs WHERE created_at >= '2025-01-01';

-- Step 4: Swap tables (brief lock)
BEGIN;
ALTER TABLE request_logs RENAME TO request_logs_old;
ALTER TABLE request_logs_new RENAME TO request_logs;
COMMIT;

-- Step 5: Drop old table after verification (run manually)
-- DROP TABLE request_logs_old;
```

### Rollback Runbooks

**Runbook 1: Application Rollback**
```markdown
## Application Rollback Procedure

**Trigger conditions:**
- Error rate > 5% for 5 minutes
- P99 latency > 1 second for 5 minutes
- Circuit breaker open on critical dependency

**Steps:**

1. **Immediate: Switch traffic to previous version**
   ```bash
   # If using blue-green
   ./scripts/switch-to-blue.sh

   # If using rolling deployment
   git checkout HEAD~1
   ./scripts/rolling-deploy.sh
   ```

2. **Verify rollback success**
   ```bash
   curl http://localhost:3000/api/v1/health | jq
   # Check: version matches previous, status is "ok"

   # Monitor error rate
   curl http://localhost:3000/metrics | grep http_errors_total
   ```

3. **Post-rollback actions**
   - Alert team in Slack: #api-incidents
   - Create incident ticket
   - Preserve logs: `docker-compose logs > incident-$(date +%s).log`
```

**Runbook 2: Database Rollback**
```markdown
## Database Migration Rollback

**Before every migration, create a restore point:**
```bash
pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
```

**Rollback steps:**

1. **Stop all API servers**
   ```bash
   ./scripts/stop-all-servers.sh
   ```

2. **Restore from backup**
   ```bash
   # Drop current database
   psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

   # Restore from backup
   psql $DATABASE_URL < backup-20250115-143022.sql
   ```

3. **Remove failed migration record**
   ```bash
   psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = 4;"
   ```

4. **Deploy previous application version**
   ```bash
   git checkout HEAD~1
   ./scripts/rolling-deploy.sh
   ```

5. **Verify system health**
   ```bash
   npm run test:integration
   ```
```

**Runbook 3: Cache Corruption Recovery**
```markdown
## Redis Cache Recovery

**Symptoms:**
- Stale data being served
- Inconsistent responses between requests
- Session authentication failures

**Steps:**

1. **Flush specific cache namespace**
   ```bash
   redis-cli KEYS "cache:*" | xargs redis-cli DEL
   # Or for sessions:
   redis-cli KEYS "session:*" | xargs redis-cli DEL
   ```

2. **Full cache flush (nuclear option)**
   ```bash
   redis-cli FLUSHDB
   ```

3. **Verify cache rebuild**
   ```bash
   # Make test requests and verify cache population
   curl http://localhost:3000/api/v1/users/1
   redis-cli GET "cache:user:1"
   ```

4. **Monitor cache hit rate recovery**
   ```bash
   watch 'redis-cli INFO stats | grep keyspace'
   ```
```

**Runbook 4: Queue Backlog Recovery**
```markdown
## RabbitMQ Queue Recovery

**Symptoms:**
- Queue depth > 10,000 messages
- Consumer lag > 1 hour
- Dead letter queue growing

**Steps:**

1. **Assess queue state**
   ```bash
   rabbitmqctl list_queues name messages consumers
   ```

2. **Scale up consumers temporarily**
   ```bash
   # Start additional consumer processes
   for i in {1..5}; do
     CONSUMER_ID=$i node src/workers/async-processor.js &
   done
   ```

3. **If messages are stale, purge queue**
   ```bash
   # Purge specific queue (data loss!)
   rabbitmqctl purge_queue api.requests.async

   # Move DLQ messages back to main queue for retry
   rabbitmqctl shovel -p / -s "amqp://" -d "amqp://" \
     -src-queue api.requests.dlq -dest-queue api.requests.async
   ```

4. **Prevent recurrence**
   - Review consumer error logs
   - Check for slow downstream dependencies
   - Consider adding circuit breaker to consumer
```

### Health Check Endpoints

```javascript
// src/routes/health.js
router.get('/health', async (req, res) => {
  const checks = {
    status: 'ok',
    version: process.env.APP_VERSION || 'dev',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // Database check
  try {
    await db.query('SELECT 1');
    checks.checks.database = { status: 'ok' };
  } catch (error) {
    checks.checks.database = { status: 'error', message: error.message };
    checks.status = 'degraded';
  }

  // Redis check
  try {
    await redis.ping();
    checks.checks.redis = { status: 'ok' };
  } catch (error) {
    checks.checks.redis = { status: 'error', message: error.message };
    checks.status = 'degraded';
  }

  // RabbitMQ check
  try {
    const channel = await rabbitmq.createChannel();
    await channel.close();
    checks.checks.rabbitmq = { status: 'ok' };
  } catch (error) {
    checks.checks.rabbitmq = { status: 'error', message: error.message };
    checks.status = 'degraded';
  }

  const statusCode = checks.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(checks);
});

// Liveness probe (for container orchestration)
router.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe (for load balancer)
router.get('/health/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});
```

---

## Implementation Notes

This section explains the WHY behind key implementation decisions, connecting code choices to system design principles.

### WHY Caching Reduces Backend Load

**Problem**: Without caching, every API request hits the database, creating a bottleneck that limits scalability.

**Solution**: Two-level caching (local + Redis) dramatically reduces database load.

```
Request Flow (without cache):
  Client -> API -> Database -> API -> Client
  Latency: 50-200ms per request
  Database load: 100% of requests

Request Flow (with cache):
  Client -> API -> Local Cache (hit) -> Client
  Latency: <1ms (local hit)
  Database load: Only cache misses (~5-10% of requests)
```

**Implementation** (`backend/shared/services/cache.js`):
- **Local cache (L1)**: 5-second TTL, eliminates Redis round-trips for hot data
- **Redis cache (L2)**: Configurable TTL, shared across all API instances
- **Cache-aside pattern**: `getOrFetch()` automatically populates cache on miss
- **Invalidation**: Pattern-based invalidation on writes (`invalidate('resources:list:*')`)

**Cost-benefit**:
- 256MB Redis cache costs ~$5/month (managed) vs. scaling database ($100+/month)
- 90%+ cache hit rate reduces P99 latency from 200ms to <10ms
- Horizontal scaling works because all instances share Redis cache

### WHY Request Retention Balances Debugging vs Storage

**Problem**: Keeping all request logs forever is expensive; deleting them immediately makes debugging impossible.

**Solution**: Tiered retention with automatic archival balances these needs.

**Implementation** (`backend/shared/config/index.js`, `backend/shared/services/retention.js`):

```javascript
retention: {
  requestLogs: {
    hot: 7,    // 7 days in PostgreSQL - fast queries for recent debugging
    warm: 30,  // 30 days compressed in object storage - investigation capability
    cold: 90,  // 90 days before permanent deletion - compliance buffer
  }
}
```

**Why these specific values**:
- **7 days hot**: Most production issues are debugged within 48 hours; 7 days covers weekly patterns
- **30 days warm**: Covers monthly billing cycles and delayed customer complaints
- **90 days cold**: Meets common compliance requirements (PCI-DSS, SOC2) without excessive storage

**Storage cost comparison** (10M requests/day):
- Hot (PostgreSQL): ~10GB/week = $50/month managed
- Warm (compressed S3): ~2GB/month = $0.05/month
- Without tiering: ~40GB/month in PostgreSQL = $200/month

### WHY Per-Endpoint Metrics Enable Optimization

**Problem**: Aggregate metrics hide which endpoints need optimization.

**Solution**: Track latency percentiles per endpoint to identify bottlenecks.

**Implementation** (`backend/shared/services/metrics.js`):

```javascript
// Per-endpoint tracking
trackEndpointLatency(method, path, duration) {
  const key = `${method}:${normalizedPath}`;
  // Track p50, p90, p99 for each endpoint
}

// Identify slow endpoints
getSlowEndpoints(thresholdMs = 500) {
  // Returns endpoints where p90 > threshold
}
```

**Why this matters**:
- **SLO monitoring**: Different endpoints may have different latency SLOs
  - `/api/v1/status`: P99 < 50ms (simple health check)
  - `/api/v1/resources`: P99 < 200ms (cached list query)
  - `/api/v1/search`: P99 < 500ms (complex query)
- **Optimization targeting**: Focus effort on endpoints with highest impact
- **Capacity planning**: Understand which endpoints drive load
- **Anomaly detection**: Alert when specific endpoint latency spikes

**Prometheus metrics exposed** (`/metrics`):
```
http_request_duration_ms{method="GET",path="/api/v1/resources",quantile="0.5"} 12
http_request_duration_ms{method="GET",path="/api/v1/resources",quantile="0.9"} 45
http_request_duration_ms{method="GET",path="/api/v1/resources",quantile="0.99"} 120
```

### WHY Circuit Breakers Prevent Cascade Failures

**Problem**: When a downstream service fails, requests pile up, exhausting resources.

```
Failure cascade without circuit breaker:
  Service A -> Service B (slow/failing)
  A's threads block waiting for B's timeout
  A exhausts its thread pool
  A starts failing
  Services calling A fail
  System-wide outage
```

**Solution**: Circuit breakers "fail fast" when a downstream service is unhealthy.

**Implementation** (`backend/shared/services/circuit-breaker.js`):

```javascript
// Three states:
// CLOSED: Normal operation, requests pass through
// OPEN: Service is down, requests fail immediately
// HALF-OPEN: Testing if service recovered

const breaker = new CircuitBreaker('payment-service', {
  failureThreshold: 5,     // Open after 5 failures
  resetTimeout: 30000,     // Try again after 30 seconds
  halfOpenRequests: 3,     // 3 successes to close
});
```

**Why these default values**:
- **5 failures**: Tolerates transient errors while catching real outages
- **30 second reset**: Gives failing service time to recover without constant probing
- **3 half-open successes**: Ensures recovery is stable before resuming full traffic

**Benefits**:
- **Fast failure**: 0ms latency vs. 30-second timeout
- **Resource protection**: No thread/connection pool exhaustion
- **Graceful degradation**: Return cached data or error message instead of hanging
- **Automatic recovery**: Half-open state tests recovery without overwhelming service

**Metrics recorded**:
```
circuit_breaker_state{name="external-service"} 0  # 0=closed, 1=half-open, 2=open
circuit_breaker_failures{name="external-service"} 3
circuit_breaker_rejects_total{name="external-service"} 150
```

### WHY Structured JSON Logging with Pino

**Problem**: Console.log statements are hard to parse, search, and correlate.

**Solution**: Structured JSON logging with request correlation.

**Implementation** (`backend/shared/services/logger.js`):

```javascript
// Every log line includes:
{
  "level": "info",
  "time": "2025-01-16T10:30:00.000Z",
  "instanceId": "api-1",
  "requestId": "abc-123",
  "userId": "user-456",
  "method": "GET",
  "path": "/api/v1/resources",
  "status": 200,
  "duration": 45,
  "msg": "Request completed"
}
```

**Why this matters**:
- **Correlation**: Filter all logs for a single request across services using `requestId`
- **Alerting**: Query for `status >= 500` or `duration > 1000`
- **Debugging**: Find all requests from a specific user with `userId`
- **Performance**: Pino is 5x faster than Winston, critical at high throughput

**Log aggregation query examples** (Elasticsearch/Loki):
```
# Find slow requests
duration > 1000 AND level = "warn"

# Find all logs for a user session
userId = "user-456" AND requestId = "abc-123"

# Error rate by endpoint
level = "error" | stats count by path
```
