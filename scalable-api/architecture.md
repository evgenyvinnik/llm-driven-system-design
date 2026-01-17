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
