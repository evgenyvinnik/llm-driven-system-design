# Bitly (URL Shortener) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for a URL shortening service that:
- Generates unique 7-character short codes at scale
- Handles 100:1 read-to-write ratio with sub-50ms redirect latency
- Tracks analytics (clicks, referrers, devices, geography)
- Supports custom short codes and link expiration

## Requirements Clarification

### Functional Requirements
1. **URL Shortening**: Generate short codes from long URLs
2. **URL Redirection**: Fast lookup and redirect to original URL
3. **Custom Short Codes**: User-specified short codes with validation
4. **Analytics Tracking**: Click counts, referrers, device types, timestamps
5. **Link Expiration**: Optional TTL for short URLs
6. **User Management**: Session-based authentication, URL ownership

### Non-Functional Requirements
1. **Latency**: < 50ms p99 for redirects, < 200ms for API calls
2. **Throughput**: 40,000 RPS for redirects at peak
3. **Availability**: 99.99% uptime for redirect service
4. **Consistency**: Strong for URL creation, eventual for analytics

### Scale Estimates
- 100M URLs created/month (~40 writes/second)
- 10B redirects/month (~4,000 reads/second)
- 6B URLs stored (5-year retention)
- 100:1 read-to-write ratio

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Load Balancer (nginx/GeoDNS)                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │ API Server  │ │ API Server  │ │ API Server  │
            │   (Node)    │ │   (Node)    │ │   (Node)    │
            └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                   │               │               │
                   └───────────────┼───────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
    │    Valkey    │      │  PostgreSQL  │      │   RabbitMQ   │
    │   (Cache +   │      │   (Primary   │      │  (Analytics  │
    │   Sessions)  │      │   Sharded)   │      │    Queue)    │
    └──────────────┘      └──────────────┘      └──────────────┘
                                                       │
                                                       ▼
                                               ┌──────────────┐
                                               │  ClickHouse  │
                                               │  (Analytics) │
                                               └──────────────┘
```

## Deep Dive: Database Schema

### Core Tables

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pre-generated key pool for unique short codes
CREATE TABLE key_pool (
    short_code VARCHAR(7) PRIMARY KEY,
    is_used BOOLEAN DEFAULT FALSE,
    allocated_to VARCHAR(50),  -- Server instance ID
    allocated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Main URLs table
CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code VARCHAR(7) UNIQUE NOT NULL,
    long_url TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    click_count BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Click events for analytics
CREATE TABLE click_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id UUID REFERENCES urls(id) ON DELETE CASCADE,
    short_code VARCHAR(7) NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    device_type VARCHAR(20),  -- mobile, tablet, desktop
    country_code VARCHAR(2),
    ip_hash VARCHAR(64),  -- SHA-256 for privacy
    clicked_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions for authentication
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_key_pool_unused ON key_pool(is_used) WHERE is_used = FALSE;
CREATE INDEX idx_urls_short_code ON urls(short_code);
CREATE INDEX idx_urls_user_id ON urls(user_id);
CREATE INDEX idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_clicks_short_code ON click_events(short_code);
CREATE INDEX idx_clicks_time ON click_events(clicked_at);
CREATE INDEX idx_sessions_token ON sessions(token);
```

### Why PostgreSQL?

| Consideration | PostgreSQL | Cassandra | DynamoDB |
|---------------|------------|-----------|----------|
| ACID transactions | Full | Limited | Limited |
| Custom code validation | Easy (unique constraint) | Complex | Complex |
| Query flexibility | Excellent | Limited | Limited |
| Sharding | Manual but predictable | Automatic | Automatic |

**Decision**: PostgreSQL with manual sharding by short_code prefix. The unique constraint on short_code ensures no collisions between custom codes and generated codes.

## Deep Dive: Short Code Generation

### Pre-generated Key Pool Service

```typescript
class KeyPoolService {
    private localCache: string[] = [];
    private readonly BATCH_SIZE = 100;
    private readonly MIN_CACHE_SIZE = 20;
    private readonly CODE_LENGTH = 7;
    private readonly ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    async getShortCode(): Promise<string> {
        if (this.localCache.length < this.MIN_CACHE_SIZE) {
            await this.refillCache();
        }

        const code = this.localCache.pop();
        if (!code) {
            throw new Error('Key pool exhausted');
        }
        return code;
    }

    private async refillCache(): Promise<void> {
        const serverId = process.env.SERVER_ID || 'default';

        // Atomic fetch and mark allocated
        const result = await db.query(`
            WITH available_keys AS (
                SELECT short_code
                FROM key_pool
                WHERE is_used = FALSE AND allocated_to IS NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE key_pool k
            SET allocated_to = $2, allocated_at = NOW()
            FROM available_keys a
            WHERE k.short_code = a.short_code
            RETURNING k.short_code
        `, [this.BATCH_SIZE, serverId]);

        this.localCache.push(...result.rows.map(r => r.short_code));
    }

    async generateKeys(count: number): Promise<void> {
        const codes = new Set<string>();

        while (codes.size < count) {
            let code = '';
            for (let i = 0; i < this.CODE_LENGTH; i++) {
                code += this.ALPHABET[Math.floor(Math.random() * this.ALPHABET.length)];
            }
            codes.add(code);
        }

        // Batch insert, ignore duplicates
        const values = [...codes].map(c => `('${c}')`).join(',');
        await db.query(`
            INSERT INTO key_pool (short_code)
            VALUES ${values}
            ON CONFLICT (short_code) DO NOTHING
        `);
    }
}
```

### Why Pre-generated Pool?

| Approach | Pros | Cons |
|----------|------|------|
| Hash-based | Deterministic, dedup built-in | Collisions, predictable, privacy issues |
| Counter-based | Simple, guaranteed unique | Single point of failure, predictable |
| **Pre-generated pool** | No coordination, random, unique | Slight complexity, key management |

**Decision**: Pre-generated pool with batch allocation to each server instance.

## Deep Dive: Redirect Service

### Cache-Aside Pattern with Fallback

```typescript
class RedirectService {
    private localCache: LRUCache<string, string>;
    private redis: Redis;
    private circuitBreaker: CircuitBreaker;

    constructor() {
        this.localCache = new LRUCache({
            max: 10000,
            ttl: 60000  // 60 seconds
        });

        this.circuitBreaker = new CircuitBreaker({
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000
        });
    }

    async getLongUrl(shortCode: string): Promise<string | null> {
        // Tier 1: Local in-memory cache
        const localHit = this.localCache.get(shortCode);
        if (localHit) {
            metrics.cacheHits.inc({ tier: 'local' });
            return localHit;
        }

        // Tier 2: Redis cache
        try {
            const redisHit = await this.redis.get(`url:${shortCode}`);
            if (redisHit) {
                metrics.cacheHits.inc({ tier: 'redis' });
                this.localCache.set(shortCode, redisHit);
                return redisHit;
            }
        } catch (error) {
            metrics.cacheErrors.inc({ tier: 'redis' });
            // Continue to database
        }

        metrics.cacheMisses.inc();

        // Tier 3: Database with circuit breaker
        const longUrl = await this.circuitBreaker.execute(async () => {
            const result = await db.query(`
                SELECT long_url, expires_at, is_active
                FROM urls
                WHERE short_code = $1
            `, [shortCode]);

            if (result.rows.length === 0) return null;

            const { long_url, expires_at, is_active } = result.rows[0];

            if (!is_active) return null;
            if (expires_at && new Date(expires_at) < new Date()) return null;

            return long_url;
        });

        if (longUrl) {
            // Populate caches
            await this.redis.setex(`url:${shortCode}`, 86400, longUrl);
            this.localCache.set(shortCode, longUrl);
        }

        return longUrl;
    }
}
```

### Redirect Endpoint

```typescript
router.get('/:shortCode', async (req, res) => {
    const { shortCode } = req.params;
    const startTime = Date.now();

    try {
        const longUrl = await redirectService.getLongUrl(shortCode);

        if (!longUrl) {
            return res.status(404).json({ error: 'URL not found' });
        }

        // Return redirect immediately
        res.redirect(302, longUrl);

        // Track analytics asynchronously (non-blocking)
        setImmediate(() => {
            analyticsService.trackClick({
                shortCode,
                referrer: req.headers.referer,
                userAgent: req.headers['user-agent'],
                ip: req.ip
            }).catch(err => logger.error('Analytics error', err));
        });

        metrics.redirectLatency.observe(Date.now() - startTime);
        metrics.redirectsTotal.inc({ cached: longUrl ? 'hit' : 'miss' });

    } catch (error) {
        logger.error('Redirect error', { shortCode, error });
        res.status(500).json({ error: 'Internal server error' });
    }
});
```

### Why 302 vs 301?

| Response Code | Behavior | Analytics Impact |
|---------------|----------|------------------|
| 301 Permanent | Browser caches, never hits server again | Loses all future clicks |
| **302 Temporary** | Browser always requests server | Captures every click |

**Decision**: Use 302 for accurate analytics tracking, accepting slightly higher server load.

## Deep Dive: Analytics Pipeline

### Async Processing with RabbitMQ

```typescript
class AnalyticsService {
    private producer: RabbitMQProducer;
    private batchSize = 100;
    private flushInterval = 5000;
    private buffer: ClickEvent[] = [];

    async trackClick(event: ClickEventInput): Promise<void> {
        const enrichedEvent = {
            ...event,
            id: crypto.randomUUID(),
            deviceType: this.parseDeviceType(event.userAgent),
            countryCode: await this.geolocate(event.ip),
            ipHash: this.hashIP(event.ip),
            clickedAt: new Date()
        };

        await this.producer.publish('analytics', 'click_events', enrichedEvent);
    }

    private parseDeviceType(userAgent: string): string {
        if (/mobile/i.test(userAgent)) return 'mobile';
        if (/tablet/i.test(userAgent)) return 'tablet';
        return 'desktop';
    }

    private hashIP(ip: string): string {
        return crypto.createHash('sha256').update(ip).digest('hex');
    }
}

// Analytics Worker
class AnalyticsWorker {
    async processClick(event: ClickEvent): Promise<void> {
        await db.query(`
            INSERT INTO click_events (
                id, url_id, short_code, referrer, user_agent,
                device_type, country_code, ip_hash, clicked_at
            )
            SELECT $1, id, $2, $3, $4, $5, $6, $7, $8
            FROM urls WHERE short_code = $2
        `, [
            event.id,
            event.shortCode,
            event.referrer,
            event.userAgent,
            event.deviceType,
            event.countryCode,
            event.ipHash,
            event.clickedAt
        ]);

        // Update click count (denormalized for fast reads)
        await db.query(`
            UPDATE urls SET click_count = click_count + 1
            WHERE short_code = $1
        `, [event.shortCode]);
    }
}
```

### ClickHouse for Analytics (Production)

```sql
-- ClickHouse schema for high-volume analytics
CREATE TABLE click_events (
    short_code String,
    clicked_at DateTime,
    referrer String,
    device_type LowCardinality(String),
    country_code LowCardinality(String),
    url_id UUID
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(clicked_at)
ORDER BY (short_code, clicked_at);

-- Materialized view for daily aggregates
CREATE MATERIALIZED VIEW clicks_daily_mv
ENGINE = SummingMergeTree()
ORDER BY (short_code, date)
AS SELECT
    short_code,
    toDate(clicked_at) AS date,
    count() AS clicks,
    uniqExact(ip_hash) AS unique_visitors
FROM click_events
GROUP BY short_code, date;
```

## Deep Dive: Caching Strategy

### Multi-Tier Cache Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Request Flow                            │
│                                                              │
│  Redirect ──► Local LRU (60s) ──► Redis (24h) ──► PostgreSQL│
│  Session  ──► Redis (7d) ──► PostgreSQL                     │
│  Rate Limit ──► Redis (1m sliding window)                   │
│  Idempotency ──► Redis (24h)                                │
└─────────────────────────────────────────────────────────────┘
```

### Cache Key Design

```typescript
const CACHE_KEYS = {
    // URL lookup (hot path)
    url: (shortCode: string) => `url:${shortCode}`,

    // Session storage
    session: (token: string) => `session:${token}`,

    // Rate limiting
    rateLimit: (ip: string, endpoint: string) => `rate:${ip}:${endpoint}`,

    // Idempotency for URL creation
    idempotency: (fingerprint: string) => `idempotency:${fingerprint}`
};
```

### Cache Invalidation

```typescript
class CacheInvalidationService {
    async onUrlDeactivated(shortCode: string): Promise<void> {
        await Promise.all([
            this.redis.del(`url:${shortCode}`),
            this.localCache.delete(shortCode)
        ]);
    }

    async onUrlExpired(shortCode: string): Promise<void> {
        // Same as deactivation
        await this.onUrlDeactivated(shortCode);
    }

    async onUrlUpdated(shortCode: string, newLongUrl: string): Promise<void> {
        // Write-through: update cache immediately
        await this.redis.setex(`url:${shortCode}`, 86400, newLongUrl);
        this.localCache.set(shortCode, newLongUrl);
    }
}
```

## Deep Dive: Rate Limiting

### Sliding Window Counter in Redis

```typescript
class RateLimiter {
    async isAllowed(
        key: string,
        limit: number,
        windowMs: number
    ): Promise<{ allowed: boolean; remaining: number }> {
        const now = Date.now();
        const windowStart = now - windowMs;

        const pipeline = this.redis.pipeline();

        // Remove old entries
        pipeline.zremrangebyscore(key, 0, windowStart);

        // Add current request
        pipeline.zadd(key, now, `${now}:${crypto.randomUUID()}`);

        // Count requests in window
        pipeline.zcount(key, windowStart, now);

        // Set expiry
        pipeline.expire(key, Math.ceil(windowMs / 1000));

        const results = await pipeline.exec();
        const count = results[2][1] as number;

        return {
            allowed: count <= limit,
            remaining: Math.max(0, limit - count)
        };
    }
}

// Rate limit configuration
const RATE_LIMITS = {
    createUrl: { limit: 10, windowMs: 60000 },      // 10/minute
    redirect: { limit: 1000, windowMs: 60000 },     // 1000/minute
    auth: { limit: 5, windowMs: 60000 }             // 5/minute (brute force)
};
```

## Deep Dive: Database Sharding

### Sharding Strategy by Short Code Prefix

```typescript
class ShardRouter {
    private shards: Map<string, Pool> = new Map();

    constructor() {
        // Configure 5 shards based on first character
        this.shards.set('shard_0', createPool('postgres://shard0...')); // 0-9, a-f
        this.shards.set('shard_1', createPool('postgres://shard1...')); // g-m
        this.shards.set('shard_2', createPool('postgres://shard2...')); // n-t
        this.shards.set('shard_3', createPool('postgres://shard3...')); // u-z
        this.shards.set('shard_4', createPool('postgres://shard4...')); // A-Z
    }

    getShardForCode(shortCode: string): Pool {
        const firstChar = shortCode[0];
        const shardId = this.getShardId(firstChar);
        return this.shards.get(shardId)!;
    }

    private getShardId(char: string): string {
        if (/[0-9a-f]/.test(char)) return 'shard_0';
        if (/[g-m]/.test(char)) return 'shard_1';
        if (/[n-t]/.test(char)) return 'shard_2';
        if (/[u-z]/.test(char)) return 'shard_3';
        return 'shard_4';  // A-Z
    }
}
```

### Why Shard by Short Code?

- **Primary access pattern**: All redirects query by short_code
- **Even distribution**: Base62 characters are uniformly distributed
- **Simple routing**: First character determines shard
- **Future growth**: Add shards by splitting existing ones

## API Design

### RESTful Endpoints

```
# URL Operations
POST   /api/v1/shorten              Create short URL
GET    /api/v1/urls/:code           Get URL metadata
GET    /api/v1/urls/:code/stats     Get click analytics
DELETE /api/v1/urls/:code           Deactivate URL

# Redirect (no /api prefix)
GET    /:short_code                 302 redirect to long URL

# Authentication
POST   /api/v1/auth/register        Create account
POST   /api/v1/auth/login           Start session
POST   /api/v1/auth/logout          End session

# Admin
GET    /api/v1/admin/stats          System statistics
POST   /api/v1/admin/key-pool       Repopulate key pool
```

### Request/Response Examples

**Create Short URL**:

```http
POST /api/v1/shorten
Idempotency-Key: client-uuid-12345
Content-Type: application/json

{
    "long_url": "https://example.com/very/long/path?with=params",
    "custom_code": "mylink",
    "expires_at": "2025-12-31T00:00:00Z"
}
```

Response (201 Created):
```json
{
    "short_url": "https://bit.ly/mylink",
    "short_code": "mylink",
    "long_url": "https://example.com/very/long/path?with=params",
    "expires_at": "2025-12-31T00:00:00Z",
    "created_at": "2025-01-15T10:30:00Z"
}
```

## Monitoring and Observability

### Key Metrics

```yaml
# Application metrics (Prometheus)
http_requests_total{method, endpoint, status}
http_request_duration_seconds{method, endpoint}
url_shortening_total{status}
url_redirects_total{cached}
cache_hits_total{tier}
cache_misses_total
key_pool_available
queue_messages_pending
circuit_breaker_state{service}
```

### Health Checks

```typescript
app.get('/health/detailed', async (req, res) => {
    const health = {
        status: 'healthy',
        dependencies: {
            database: await checkDatabase(),
            redis: await checkRedis(),
            rabbitmq: await checkRabbitMQ()
        },
        keyPool: {
            localCache: keyPoolService.getCacheSize(),
            circuitBreaker: circuitBreaker.getState()
        }
    };

    const isHealthy = Object.values(health.dependencies)
        .every(d => d.status === 'connected');

    res.status(isHealthy ? 200 : 503).json(health);
});
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Pre-generated key pool | No coordination, random codes | Key management complexity |
| 302 redirect | Accurate analytics | Higher server load |
| Two-tier cache | Low latency, shared state | Memory overhead |
| Async analytics | Non-blocking redirects | Slight delay in stats |
| PostgreSQL sharding | Predictable, ACID | Manual shard management |
| RabbitMQ for analytics | Backpressure handling | Additional infrastructure |

## Future Backend Enhancements

1. **Bloom Filter**: Skip database lookup for non-existent codes
2. **CDN Edge Workers**: Redirect at edge for global latency
3. **Malicious URL Detection**: Integrate Google Safe Browsing API
4. **Bulk API**: Create multiple short URLs in single request
5. **Webhooks**: Notify on click thresholds
6. **Multi-region**: Active-active deployment with cross-region replication
7. **Event Sourcing**: Audit trail for all URL operations
