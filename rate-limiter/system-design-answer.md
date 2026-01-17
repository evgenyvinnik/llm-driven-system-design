# Rate Limiter - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a distributed rate limiting service that can protect APIs from abuse while maintaining low latency. This is a fundamental building block for any API platform. Let me clarify the requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Request Counting** - Track number of requests per client/API key
2. **Multiple Algorithms** - Support different rate limiting strategies (fixed window, sliding window, token bucket, leaky bucket)
3. **Distributed Limiting** - Work across multiple API servers consistently
4. **Custom Rules** - Configure different limits per endpoint, user tier, API key
5. **Response Headers** - Return remaining quota and reset time to clients

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **High Availability** - Must not become a single point of failure
- **Accuracy** - Limits should be respected within 1-5% tolerance
- **Scalability** - Handle 1M+ requests per second

### Out of Scope

"For this discussion, I'll set aside: DDoS protection (layer 3/4 attacks), geographic-based limiting, and machine learning-based anomaly detection."

---

## 2. Scale Estimation (3 minutes)

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

---

## 3. High-Level Architecture (8 minutes)

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

### Rate Limiter as Middleware

```python
class RateLimitMiddleware:
    async def __call__(self, request, next):
        # Extract identifier (API key, user ID, IP)
        identifier = self.get_identifier(request)

        # Get applicable rule
        rule = await self.get_rule(request.endpoint, identifier)

        # Check limit
        result = await self.rate_limiter.check(identifier, rule)

        if not result.allowed:
            return Response(
                status=429,
                headers={
                    'X-RateLimit-Limit': rule.limit,
                    'X-RateLimit-Remaining': 0,
                    'X-RateLimit-Reset': result.reset_time,
                    'Retry-After': result.retry_after
                },
                body={'error': 'Rate limit exceeded'}
            )

        # Proceed with request
        response = await next(request)

        # Add rate limit headers
        response.headers.update({
            'X-RateLimit-Limit': rule.limit,
            'X-RateLimit-Remaining': result.remaining,
            'X-RateLimit-Reset': result.reset_time
        })

        return response
```

---

## 4. Rate Limiting Algorithms (10 minutes)

"Let me walk through the main algorithms and their trade-offs."

### Algorithm 1: Fixed Window Counter

```
Time:    |-------- Window 1 --------|-------- Window 2 --------|
         0                          60                         120

Requests: [x x x x x x x x x x]      [x x x x x x]
Count:           10                        6
Limit:           10                       10
```

**Implementation:**

```python
async def fixed_window_check(identifier, limit, window_seconds):
    window_start = int(time.time() / window_seconds) * window_seconds
    key = f"ratelimit:{identifier}:{window_start}"

    # Atomic increment and get
    current = await redis.incr(key)

    if current == 1:
        await redis.expire(key, window_seconds + 1)

    if current > limit:
        return RateLimitResult(allowed=False, remaining=0)

    return RateLimitResult(allowed=True, remaining=limit - current)
```

**Pros**: Simple, memory efficient (one counter per window)
**Cons**: Burst at window boundaries (can allow 2x limit briefly)

---

### Algorithm 2: Sliding Window Log

```
Keep timestamp of each request, count requests in last N seconds

Requests: [t1, t2, t3, t4, t5, t6, t7, t8]
Window:   |<------------ 60 seconds ------------>|
                                           now ^
```

**Implementation:**

```python
async def sliding_log_check(identifier, limit, window_seconds):
    key = f"ratelimit:{identifier}"
    now = time.time()
    window_start = now - window_seconds

    # Remove old entries and add new one atomically
    pipeline = redis.pipeline()
    pipeline.zremrangebyscore(key, 0, window_start)
    pipeline.zadd(key, {str(now): now})
    pipeline.zcard(key)
    pipeline.expire(key, window_seconds + 1)

    results = await pipeline.execute()
    current_count = results[2]

    if current_count > limit:
        return RateLimitResult(allowed=False, remaining=0)

    return RateLimitResult(allowed=True, remaining=limit - current_count)
```

**Pros**: Perfectly accurate sliding window
**Cons**: Memory-intensive (stores every request timestamp)

---

### Algorithm 3: Sliding Window Counter (Hybrid)

```
Combine current and previous window counts weighted by time

Previous Window    Current Window
[====count=====]   [==count===|----remaining----|]
     100                 40        ^
                                  now (30% into window)

Weighted count = 100 * 0.70 + 40 = 110
```

**Implementation:**

```python
async def sliding_window_check(identifier, limit, window_seconds):
    now = time.time()
    current_window = int(now / window_seconds)
    previous_window = current_window - 1

    # Position within current window (0.0 to 1.0)
    position = (now % window_seconds) / window_seconds

    current_key = f"ratelimit:{identifier}:{current_window}"
    previous_key = f"ratelimit:{identifier}:{previous_window}"

    # Get both counts
    current_count, previous_count = await redis.mget(current_key, previous_key)
    current_count = int(current_count or 0)
    previous_count = int(previous_count or 0)

    # Weighted count
    weighted_count = previous_count * (1 - position) + current_count

    if weighted_count >= limit:
        return RateLimitResult(allowed=False, remaining=0)

    # Increment current window
    await redis.incr(current_key)
    await redis.expire(current_key, window_seconds * 2)

    return RateLimitResult(allowed=True, remaining=limit - weighted_count - 1)
```

**Pros**: Smooth limiting, memory efficient
**Cons**: Approximate (but within 1-2% accuracy)

---

### Algorithm 4: Token Bucket

```
Bucket refills at constant rate, requests consume tokens

Bucket: [* * * * * * * * * *]  capacity = 10
        [* * * * * * * *]      after 2 requests
        [* * * * * * * * *]    after refill

Refill rate: 1 token per second
```

**Implementation:**

```python
async def token_bucket_check(identifier, capacity, refill_rate):
    key = f"bucket:{identifier}"
    now = time.time()

    # Atomic Lua script for token bucket
    lua_script = """
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or capacity
    local last_refill = tonumber(bucket[2]) or now

    -- Calculate refill
    local elapsed = now - last_refill
    local refill = elapsed * refill_rate
    tokens = math.min(capacity, tokens + refill)

    -- Try to consume token
    if tokens >= 1 then
        tokens = tokens - 1
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, capacity / refill_rate + 10)
        return {1, tokens}  -- allowed, remaining
    else
        return {0, 0}  -- denied
    end
    """

    result = await redis.eval(lua_script, 1, key, capacity, refill_rate, now)
    return RateLimitResult(allowed=result[0] == 1, remaining=result[1])
```

**Pros**: Allows controlled bursts, smooth rate limiting
**Cons**: More complex state, harder to explain limits to users

---

### Algorithm 5: Leaky Bucket

```
Requests enter queue, processed at fixed rate

Queue: [req1] [req2] [req3] [req4] --> [processing] --> done
                                            |
                                       fixed rate
```

**Implementation:**

```python
async def leaky_bucket_check(identifier, bucket_size, leak_rate):
    key = f"leaky:{identifier}"
    now = time.time()

    lua_script = """
    local key = KEYS[1]
    local bucket_size = tonumber(ARGV[1])
    local leak_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local bucket = redis.call('HMGET', key, 'water', 'last_leak')
    local water = tonumber(bucket[1]) or 0
    local last_leak = tonumber(bucket[2]) or now

    -- Leak water based on time passed
    local elapsed = now - last_leak
    local leaked = elapsed * leak_rate
    water = math.max(0, water - leaked)

    -- Try to add water (new request)
    if water < bucket_size then
        water = water + 1
        redis.call('HMSET', key, 'water', water, 'last_leak', now)
        redis.call('EXPIRE', key, bucket_size / leak_rate + 10)
        return {1, bucket_size - water}
    else
        return {0, 0}
    end
    """

    result = await redis.eval(lua_script, 1, key, bucket_size, leak_rate, now)
    return RateLimitResult(allowed=result[0] == 1, remaining=result[1])
```

**Pros**: Smoothest output rate, prevents bursts entirely
**Cons**: Requests may queue, adding latency

---

## 5. Configuration System (3 minutes)

### Rule Definition

```sql
CREATE TABLE rate_limit_rules (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    endpoint_pattern VARCHAR(255),        -- e.g., '/api/v1/*' or NULL for all
    identifier_type VARCHAR(50),          -- 'api_key', 'user_id', 'ip'
    user_tier       VARCHAR(50),          -- 'free', 'pro', 'enterprise'
    algorithm       VARCHAR(50) NOT NULL,
    limit_value     INTEGER NOT NULL,
    window_seconds  INTEGER NOT NULL,
    priority        INTEGER DEFAULT 0,    -- Higher = checked first
    enabled         BOOLEAN DEFAULT true
);

-- Example rules
INSERT INTO rate_limit_rules VALUES
(1, 'Free tier global',    NULL,           'api_key', 'free',       'sliding_window', 100,  60,   0, true),
(2, 'Pro tier global',     NULL,           'api_key', 'pro',        'sliding_window', 1000, 60,   0, true),
(3, 'Enterprise global',   NULL,           'api_key', 'enterprise', 'token_bucket',   10000, 60,  0, true),
(4, 'Search endpoint',     '/api/search*', 'api_key', NULL,         'sliding_window', 10,   60,  10, true);
```

### Rule Matching

```python
async def get_applicable_rule(endpoint, identifier, user_tier):
    # Check cache first
    cache_key = f"rule:{endpoint}:{user_tier}"
    cached = await redis.get(cache_key)
    if cached:
        return deserialize(cached)

    # Query database
    rules = await db.query("""
        SELECT * FROM rate_limit_rules
        WHERE enabled = true
        AND (endpoint_pattern IS NULL OR :endpoint LIKE endpoint_pattern)
        AND (user_tier IS NULL OR user_tier = :tier)
        ORDER BY priority DESC, specificity DESC
        LIMIT 1
    """, endpoint=endpoint, tier=user_tier)

    rule = rules[0] if rules else DEFAULT_RULE
    await redis.setex(cache_key, 300, serialize(rule))

    return rule
```

---

## 6. Distributed Consistency (5 minutes)

### Challenge: Multiple Gateway Nodes

```
Without coordination:

Node 1: count = 5   ─┐
Node 2: count = 4   ─┼─ Total should be 12, but each node only sees partial count
Node 3: count = 3   ─┘
```

### Solution: Centralized Redis Counter

All nodes increment the same Redis key, ensuring globally accurate counts.

### Handling Redis Latency

```python
class HybridRateLimiter:
    def __init__(self):
        self.local_cache = {}
        self.sync_interval = 0.1  # 100ms

    async def check(self, identifier, limit):
        # Fast path: check local approximation
        local = self.local_cache.get(identifier, {'count': 0, 'last_sync': 0})

        if local['count'] >= limit * 0.9:  # Approaching limit
            # Sync with Redis immediately
            return await self.redis_check(identifier, limit)

        # Optimistic allow, sync in background
        local['count'] += 1
        self.local_cache[identifier] = local

        if time.time() - local['last_sync'] > self.sync_interval:
            asyncio.create_task(self.sync_to_redis(identifier))

        return RateLimitResult(allowed=True, remaining=limit - local['count'])

    async def sync_to_redis(self, identifier):
        local = self.local_cache[identifier]
        await redis.incrby(f"ratelimit:{identifier}", local['count'])
        local['count'] = 0
        local['last_sync'] = time.time()
```

### Trade-off: Accuracy vs. Latency

| Approach | Latency | Accuracy | Complexity |
|----------|---------|----------|------------|
| Always Redis | 1-2ms | 100% | Low |
| Local + Periodic Sync | <0.1ms | 95% | Medium |
| Local + Sync on Threshold | 0.1-1ms | 99% | Medium |

---

## 7. High Availability (3 minutes)

### Redis Cluster Setup

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Primary 1  │     │  Primary 2  │     │  Primary 3  │
│ (slots 0-5K)│     │(slots 5K-10K)│    │(slots 10K-16K)│
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
│  Replica 1  │     │  Replica 2  │     │  Replica 3  │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Graceful Degradation

```python
async def check_with_fallback(identifier, limit):
    try:
        return await rate_limiter.check(identifier, limit)
    except RedisConnectionError:
        # Fallback 1: Use local counter
        return local_rate_limiter.check(identifier, limit)
    except TimeoutError:
        # Fallback 2: Allow request (fail open)
        log.warning(f"Rate limiter timeout, allowing request")
        return RateLimitResult(allowed=True, remaining=unknown)
```

### Fail-Open vs. Fail-Close

**Fail-Open** (allow on error): Risk of overload during Redis outage
**Fail-Close** (deny on error): Better protection but impacts availability

"For most APIs, I'd recommend fail-open with alerting, since rate limiting is about protecting resources from sustained abuse, not blocking individual requests."

---

## 8. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Centralized vs. Local Rate Limiting

**Chose**: Centralized Redis for accuracy
**Trade-off**: Adds 1-2ms latency; Redis becomes critical dependency
**Alternative**: Pure local limiting (faster but limits can be exceeded)

### Trade-off 2: Algorithm Selection

| Use Case | Recommended Algorithm |
|----------|----------------------|
| Simple API quota | Fixed/Sliding Window |
| Traffic shaping | Token Bucket |
| Consistent processing rate | Leaky Bucket |

### Trade-off 3: Exact vs. Approximate Counting

**Chose**: Sliding window counter (approximate)
**Trade-off**: ~1-2% error tolerance acceptable for most use cases
**Alternative**: Sliding log for exact counting (10x more memory)

---

## 9. Monitoring and Observability (2 minutes)

### Key Metrics

```python
# Prometheus metrics
rate_limit_checks_total = Counter(
    'rate_limit_checks_total',
    'Total rate limit checks',
    ['endpoint', 'result']  # result: allowed, denied
)

rate_limit_latency = Histogram(
    'rate_limit_latency_seconds',
    'Rate limit check latency'
)

rate_limit_remaining = Gauge(
    'rate_limit_remaining',
    'Remaining quota',
    ['identifier']
)
```

### Alerting Rules

```yaml
- alert: HighRateLimitDenials
  expr: rate(rate_limit_checks_total{result="denied"}[5m]) > 1000
  for: 5m
  annotations:
    summary: "High rate limit denials - possible abuse or misconfiguration"

- alert: RateLimiterLatencyHigh
  expr: histogram_quantile(0.99, rate_limit_latency) > 0.01
  for: 5m
  annotations:
    summary: "Rate limiter p99 latency > 10ms"
```

---

## Summary

"To summarize, I've designed a distributed rate limiter with:

1. **Multiple algorithms** (fixed window, sliding window, token bucket, leaky bucket) for different use cases
2. **Redis-based centralized counting** for distributed accuracy across API gateway nodes
3. **Configurable rules** per endpoint, user tier, and API key
4. **Low latency** (<5ms) with optional local caching for optimization
5. **High availability** through Redis Cluster and graceful degradation
6. **Standard headers** (X-RateLimit-*) for client transparency

The key insight is that rate limiting is a trade-off between accuracy, latency, and complexity. For most production systems, the sliding window counter provides the best balance."

---

## Questions I'd Expect

**Q: How do you handle clock skew across servers?**
A: For time-window algorithms, all servers use Redis server time (via TIME command or Lua scripts). Window boundaries are based on Redis timestamps, not local server time.

**Q: How do you rate limit at 1M+ RPS?**
A: Sharding by identifier across Redis Cluster nodes, local caching with periodic sync, and potentially moving to a sampling-based approach for extreme scale.

**Q: What about rate limiting WebSocket connections?**
A: Different model - limit connections per user rather than requests. Track active connection count in Redis with connection IDs, decrement on disconnect.
