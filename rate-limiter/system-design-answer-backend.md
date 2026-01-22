# Rate Limiter - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a distributed rate limiting service that can protect APIs from abuse while maintaining low latency. As a backend engineer, I'll focus on the rate limiting algorithms, Redis-based distributed counting, Lua scripts for atomicity, circuit breakers, and ensuring sub-5ms latency. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Request Counting** - Track number of requests per client/API key
2. **Multiple Algorithms** - Support different rate limiting strategies
3. **Distributed Limiting** - Work across multiple API servers consistently
4. **Custom Rules** - Configure different limits per endpoint, user tier
5. **Response Headers** - Return remaining quota and reset time to clients

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **High Availability** - Must not become a single point of failure
- **Accuracy** - Limits should be respected within 1-5% tolerance
- **Scalability** - Handle 100K+ requests per second

### Backend-Specific Considerations

- Atomic operations to prevent race conditions
- Distributed state consistency across API gateway nodes
- Graceful degradation when Redis is unavailable
- Efficient key expiration to prevent memory bloat

---

## 2. High-Level Architecture (5 minutes)

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

| Component | Purpose | Technology |
|-----------|---------|------------|
| Rate Limiter Middleware | Intercepts requests, enforces limits | Express middleware |
| Algorithm Factory | Creates appropriate limiter per config | TypeScript classes |
| Redis Client | Manages distributed state | ioredis with Lua scripts |
| Circuit Breaker | Handles Redis failures gracefully | opossum library |

---

## 3. Deep Dive: Rate Limiting Algorithms (10 minutes)

### Algorithm 1: Fixed Window Counter

```
Time:    |-------- Window 1 --------|-------- Window 2 --------|
         0                          60                         120
Requests: [x x x x x x x x x x]      [x x x x x x]
Count:           10                        6
```

```typescript
async function fixedWindowCheck(
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const key = `ratelimit:fixed:${identifier}:${windowStart}`;

  // Atomic increment
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, windowSeconds + 1);
  }

  if (current > limit) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: limit - current };
}
```

**Pros**: Simple, memory efficient (one counter per window)
**Cons**: Burst at window boundaries (can allow 2x limit briefly)

---

### Algorithm 2: Sliding Window Counter (Default)

```
Previous Window    Current Window
[====count=====]   [==count===|----remaining----|]
     100                 40        ^
                                  now (30% into window)

Weighted count = 100 * 0.70 + 40 = 110
```

```typescript
async function slidingWindowCheck(
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now() / 1000;
  const currentWindow = Math.floor(now / windowSeconds);
  const previousWindow = currentWindow - 1;

  // Position within current window (0.0 to 1.0)
  const position = (now % windowSeconds) / windowSeconds;

  const currentKey = `ratelimit:sliding:${identifier}:${currentWindow}`;
  const previousKey = `ratelimit:sliding:${identifier}:${previousWindow}`;

  // Get both counts
  const [currentCount, previousCount] = await redis.mget(currentKey, previousKey);

  // Weighted count
  const weightedCount =
    parseInt(previousCount || '0') * (1 - position) +
    parseInt(currentCount || '0');

  if (weightedCount >= limit) {
    return { allowed: false, remaining: 0 };
  }

  // Increment current window
  await redis.multi()
    .incr(currentKey)
    .expire(currentKey, windowSeconds * 2)
    .exec();

  return { allowed: true, remaining: Math.floor(limit - weightedCount - 1) };
}
```

**Pros**: Smooth limiting, memory efficient, ~98% accuracy
**Cons**: Approximate (1-2% error tolerance)

---

### Algorithm 3: Token Bucket (Lua Script)

```
Bucket refills at constant rate, requests consume tokens

Bucket: [* * * * * * * * * *]  capacity = 10
        [* * * * * * * *]      after 2 requests
        [* * * * * * * * *]    after refill
```

```typescript
const tokenBucketScript = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
  local tokens = tonumber(bucket[1]) or capacity
  local lastRefill = tonumber(bucket[2]) or now

  -- Calculate refill
  local elapsed = now - lastRefill
  local refill = elapsed * refillRate
  tokens = math.min(capacity, tokens + refill)

  -- Try to consume token
  if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, capacity / refillRate + 10)
    return {1, math.floor(tokens)}  -- allowed, remaining
  else
    return {0, 0}  -- denied
  end
`;

async function tokenBucketCheck(
  identifier: string,
  capacity: number,
  refillRate: number
): Promise<RateLimitResult> {
  const key = `ratelimit:token:${identifier}`;
  const now = Date.now() / 1000;

  const result = await redis.eval(
    tokenBucketScript,
    1,
    key,
    capacity,
    refillRate,
    now
  );

  return {
    allowed: result[0] === 1,
    remaining: result[1]
  };
}
```

**Why Lua Script?** Token bucket requires read-modify-write atomicity. Without Lua, race conditions between multiple API servers could cause inaccurate token counts.

---

### Algorithm 4: Leaky Bucket

```typescript
const leakyBucketScript = `
  local key = KEYS[1]
  local bucketSize = tonumber(ARGV[1])
  local leakRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  local bucket = redis.call('HMGET', key, 'water', 'last_leak')
  local water = tonumber(bucket[1]) or 0
  local lastLeak = tonumber(bucket[2]) or now

  -- Leak water based on time passed
  local elapsed = now - lastLeak
  local leaked = elapsed * leakRate
  water = math.max(0, water - leaked)

  -- Try to add water (new request)
  if water < bucketSize then
    water = water + 1
    redis.call('HMSET', key, 'water', water, 'last_leak', now)
    redis.call('EXPIRE', key, bucketSize / leakRate + 10)
    return {1, math.floor(bucketSize - water)}
  else
    return {0, 0}
  end
`;
```

**Pros**: Smoothest output rate, prevents bursts entirely
**Cons**: Requests may queue, adding latency

---

## 4. Deep Dive: Circuit Breaker Pattern (6 minutes)

### Why Circuit Breakers?

Without a circuit breaker, Redis failures cause:
1. **Thread Pool Exhaustion** - Each blocked request holds a connection
2. **Cascading Latency** - Request latency spikes to timeout duration
3. **Thundering Herd** - All requests fail simultaneously

### Implementation

```typescript
import CircuitBreaker from 'opossum';

const redisBreaker = new CircuitBreaker(redisOperation, {
  timeout: 3000,                    // 3s operation timeout
  errorThresholdPercentage: 50,     // Open after 50% failures
  resetTimeout: 10000,              // 10s before testing recovery
  volumeThreshold: 5                // Min requests before opening
});

redisBreaker.on('open', () => {
  logger.warn('Redis circuit opened - failing open for rate checks');
  metrics.increment('circuit_breaker.redis.open');
});

// Fallback: fail-open (allow requests)
redisBreaker.fallback(() => ({
  allowed: true,
  fallback: true,
  remaining: -1,
  resetAt: Date.now() + 60000
}));
```

### State Machine

```
CLOSED -> (failures exceed threshold) -> OPEN
OPEN -> (recovery timeout) -> HALF_OPEN
HALF_OPEN -> (success) -> CLOSED
HALF_OPEN -> (failure) -> OPEN
```

### Fail-Open vs Fail-Closed

| Strategy | When to Use | Risk | Mitigation |
|----------|-------------|------|------------|
| Fail-Open | Most APIs | Temporary abuse | Aggressive alerting |
| Fail-Closed | Auth, payments | Service outage | Multi-region Redis |

---

## 5. Deep Dive: Redis Key Management (5 minutes)

### Key Structure

```
# Fixed Window
ratelimit:fixed:{identifier}:{window_start} -> count

# Sliding Window
ratelimit:sliding:{identifier}:{window_number} -> count

# Token Bucket
ratelimit:token:{identifier} -> hash {tokens, last_refill}

# Leaky Bucket
ratelimit:leaky:{identifier} -> hash {water, last_leak}
```

### TTL Strategy

| Key Pattern | TTL | Rationale |
|-------------|-----|-----------|
| `ratelimit:fixed:*` | 2x window | Covers window + buffer |
| `ratelimit:sliding:*` | 2x window | Covers current + previous |
| `ratelimit:token:*` | 24 hours | Reset daily inactive |
| `ratelimit:leaky:*` | 24 hours | Reset daily inactive |

```typescript
function calculateKeyTtl(windowSeconds: number): number {
  return Math.ceil(windowSeconds * 2);  // 2x window size
}

// Why 2x? Sliding window needs previous window data
// At 12:01:30, we're 50% into Window 2 but need Window 1 for weighted calc
```

### Memory Estimation

```
100,000 API keys x ~200 bytes/key = ~20 MB
With sliding window: 2 keys per user = ~40 MB
Safely fits in Redis with room for growth
```

---

## 6. Deep Dive: Rate Limit Middleware (5 minutes)

### Express Middleware Implementation

```typescript
interface RateLimitRule {
  algorithm: 'fixed' | 'sliding' | 'token' | 'leaky';
  limit: number;
  windowSeconds: number;
  burstCapacity?: number;
  refillRate?: number;
}

export function rateLimitMiddleware(
  getRule: (req: Request) => Promise<RateLimitRule>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = extractIdentifier(req);
    const rule = await getRule(req);

    let result: RateLimitResult;

    try {
      result = await circuitBreaker.fire(() =>
        checkRateLimit(identifier, rule)
      );
    } catch (error) {
      // Circuit breaker fallback
      result = { allowed: true, fallback: true, remaining: -1 };
      logger.warn('Rate limit check failed, allowing request', { identifier });
    }

    // Set response headers
    res.set({
      'X-RateLimit-Limit': rule.limit,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': result.resetAt,
      'X-RateLimit-Algorithm': rule.algorithm
    });

    if (!result.allowed) {
      res.set('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: result.resetAt
      });
    }

    next();
  };
}

function extractIdentifier(req: Request): string {
  // Priority: API key > User ID > IP address
  return req.headers['x-api-key'] as string
    || req.user?.id
    || req.ip;
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| State storage | Centralized Redis | Adds 1-2ms latency | Local counters (faster, less accurate) |
| Default algorithm | Sliding window | ~2% error | Sliding log (exact, 10x memory) |
| Atomicity | Lua scripts | More complex | Pipeline (race conditions) |
| Failure mode | Fail-open | Risk during outage | Fail-closed (blocks users) |
| Clock source | Redis server time | Single source | Local time (clock skew issues) |

---

## 8. Metrics and Observability

```typescript
// Prometheus metrics
const metrics = {
  checks: new Counter({
    name: 'ratelimiter_checks_total',
    help: 'Total rate limit checks',
    labelNames: ['result', 'algorithm']
  }),

  latency: new Histogram({
    name: 'ratelimiter_check_duration_seconds',
    help: 'Rate limit check latency',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
  }),

  circuitState: new Gauge({
    name: 'ratelimiter_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)'
  })
};

// Alert on high denial rate
// expr: sum(rate(ratelimiter_checks_total{result="denied"}[5m])) /
//       sum(rate(ratelimiter_checks_total[5m])) > 0.1
```

---

## 9. Future Enhancements

1. **Local Caching** - Hybrid approach with periodic Redis sync
2. **Rule Engine** - Dynamic rules from PostgreSQL with caching
3. **Distributed Tracing** - OpenTelemetry integration
4. **Adaptive Limits** - ML-based anomaly detection
5. **Geo-based Limiting** - Different limits per region

---

## Summary

"To summarize, I've designed a distributed rate limiter with:

1. **Multiple algorithms** (fixed window, sliding window, token bucket, leaky bucket) implemented with Redis, using Lua scripts for atomicity
2. **Sliding window as default** providing 98% accuracy with low memory footprint
3. **Circuit breaker pattern** for graceful degradation when Redis is unavailable
4. **Fail-open strategy** to prioritize availability during infrastructure issues
5. **TTL-based key expiration** to prevent unbounded memory growth
6. **Sub-5ms latency** through optimized Redis operations and connection pooling

The key insight is that rate limiting is a trade-off between accuracy, latency, and complexity. For most production systems, the sliding window counter provides the best balance, and fail-open is the right default since we're protecting against sustained abuse rather than individual requests."
