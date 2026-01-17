# Bit.ly - URL Shortener - Architecture Design

## System Overview

A URL shortening service that converts long URLs into short, memorable links. This design supports a local development learning project that simulates distributed system behavior with 2-5 service instances.

## Requirements

### Functional Requirements

- **URL shortening**: Convert long URLs to 7-character short codes
- **URL redirection**: Redirect short URLs to original destinations with 302 response
- **Analytics tracking**: Record clicks with referrer, device type, and timestamp
- **Custom short URLs**: Allow users to specify custom short codes
- **Link expiration**: Support optional expiration dates for URLs
- **User authentication**: Session-based login for URL management

### Non-Functional Requirements

- **Scalability**: Support 2-5 local server instances behind a load balancer
- **Availability**: Target 99.9% uptime (allows ~8.7 hours downtime/year)
- **Latency**: p99 redirect latency < 50ms, p99 API latency < 200ms
- **Consistency**: Eventual consistency for analytics, strong consistency for URL creation

## Capacity Estimation (Local Development Scale)

These estimates size components for a learning environment, not production:

| Metric | Value | Notes |
|--------|-------|-------|
| Daily Active Users (DAU) | 100 | Local testing scale |
| URLs created per day | 500 | ~0.006 RPS write |
| Redirects per day | 10,000 | ~0.12 RPS read |
| Peak redirect RPS | 10 | 10x average during burst |
| Peak write RPS | 1 | Rare concurrent writes |
| Storage per URL | ~500 bytes | short_code + long_url + metadata |
| URLs stored (1 year) | 182,500 | 500/day x 365 days |
| Total URL storage | ~90 MB | Fits easily in PostgreSQL |
| Click events per day | 10,000 | ~30 bytes each |
| Analytics storage (1 year) | ~110 MB | 3.65M events x 30 bytes |

### Component Sizing

Based on these estimates:

- **PostgreSQL**: Single instance, default configuration (sufficient for <1 RPS writes)
- **Redis/Valkey**: 128 MB memory (holds ~250K cached URLs)
- **API Servers**: 2-3 instances with 256 MB RAM each
- **Key Pool**: Pre-generate 10,000 keys (covers 20 days of URL creation)

## High-Level Architecture

```
                                    ┌─────────────────┐
                                    │   Web Browser   │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  nginx (LB)     │
                                    │  Port 3000      │
                                    └────────┬────────┘
                         ┌───────────────────┼───────────────────┐
                         │                   │                   │
                ┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
                │  API Server 1   │ │  API Server 2   │ │  API Server 3   │
                │  Port 3001      │ │  Port 3002      │ │  Port 3003      │
                └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
                         │                   │                   │
                         └───────────────────┼───────────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
           ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
           │  Redis/Valkey   │      │   PostgreSQL    │      │   RabbitMQ      │
           │  Port 6379      │      │   Port 5432     │      │   Port 5672     │
           │  (Cache)        │      │   (Primary DB)  │      │   (Analytics)   │
           └─────────────────┘      └─────────────────┘      └─────────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| Load Balancer | Distribute requests across API servers | nginx with round-robin |
| API Server | Handle URL operations and redirects | Node.js + Express + TypeScript |
| Cache | Fast URL lookups, session storage | Redis/Valkey |
| Primary Database | URL metadata, users, key pool | PostgreSQL |
| Message Queue | Async analytics processing | RabbitMQ |
| Analytics Worker | Process click events from queue | Node.js background service |

### Request Flow

#### URL Shortening (Write Path)

```
1. Client → POST /api/v1/shorten { long_url, custom_code?, expires_at? }
2. API validates URL format and length (max 2048 chars)
3. API fetches unused short_code from local key cache (or DB if cache empty)
4. API inserts URL record into PostgreSQL (transaction)
5. API writes to Redis cache: url:{short_code} → long_url
6. API returns { short_url, short_code, expires_at }
```

#### URL Redirect (Read Path)

```
1. Client → GET /{short_code}
2. API checks Redis cache for url:{short_code}
3. If cache miss: query PostgreSQL, populate cache
4. If URL expired or not found: return 404
5. API returns 302 redirect to long_url
6. API publishes click event to RabbitMQ (async, non-blocking)
7. Analytics worker consumes event, writes to click_events table
```

## Data Model

### Database Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Pre-generated key pool
CREATE TABLE key_pool (
    short_code VARCHAR(7) PRIMARY KEY,
    is_used BOOLEAN DEFAULT FALSE,
    allocated_to VARCHAR(50),  -- server instance ID
    allocated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_key_pool_unused ON key_pool(is_used) WHERE is_used = FALSE;

-- URLs table
CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code VARCHAR(7) UNIQUE NOT NULL,
    long_url TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMP,
    click_count BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_urls_short_code ON urls(short_code);
CREATE INDEX idx_urls_user_id ON urls(user_id);
CREATE INDEX idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;

-- Click events (analytics)
CREATE TABLE click_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id UUID REFERENCES urls(id) ON DELETE CASCADE,
    short_code VARCHAR(7) NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    device_type VARCHAR(20),  -- mobile, tablet, desktop
    country_code VARCHAR(2),
    ip_hash VARCHAR(64),  -- SHA-256 hash for privacy
    clicked_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_clicks_url_id ON click_events(url_id);
CREATE INDEX idx_clicks_short_code ON click_events(short_code);
CREATE INDEX idx_clicks_time ON click_events(clicked_at);
-- Partition by month for efficient queries and retention
-- (For production: CREATE TABLE click_events ... PARTITION BY RANGE (clicked_at))
```

### Storage Strategy

| Data Type | Storage | TTL/Retention | Rationale |
|-----------|---------|---------------|-----------|
| URL metadata | PostgreSQL | Indefinite (or until expired) | Strong consistency, relational queries |
| Key pool | PostgreSQL | Indefinite | Transactional allocation |
| Sessions | Redis + PostgreSQL | 7 days | Fast lookup, DB fallback |
| URL cache | Redis | 24 hours | Hot path optimization |
| Click events | PostgreSQL | 90 days | Sufficient for analytics, then archive |

## API Design

### Core Endpoints

```
# Public API
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
GET    /api/v1/auth/me              Get current user

# User Dashboard
GET    /api/v1/user/urls            List user's URLs
GET    /api/v1/user/stats           User's aggregate stats

# Admin API
GET    /api/v1/admin/stats          System-wide statistics
GET    /api/v1/admin/urls           List all URLs (paginated)
GET    /api/v1/admin/users          List all users
POST   /api/v1/admin/key-pool       Repopulate key pool
DELETE /api/v1/admin/urls/:code     Force-delete any URL
```

### Request/Response Examples

```json
// POST /api/v1/shorten
// Request
{
  "long_url": "https://example.com/very/long/path?with=params",
  "custom_code": "mylink",   // optional
  "expires_at": "2025-12-31" // optional
}

// Response (201 Created)
{
  "short_url": "http://localhost:3000/abc1234",
  "short_code": "abc1234",
  "long_url": "https://example.com/very/long/path?with=params",
  "expires_at": null,
  "created_at": "2025-01-15T10:30:00Z"
}

// GET /api/v1/urls/:code/stats
// Response
{
  "short_code": "abc1234",
  "total_clicks": 142,
  "unique_visitors": 98,
  "clicks_by_day": [
    { "date": "2025-01-14", "count": 45 },
    { "date": "2025-01-15", "count": 97 }
  ],
  "top_referrers": [
    { "referrer": "twitter.com", "count": 67 },
    { "referrer": "direct", "count": 42 }
  ],
  "devices": {
    "mobile": 68,
    "desktop": 71,
    "tablet": 3
  }
}
```

## Key Design Decisions

### 1. Short Code Generation: Pre-generated Key Pool

**Approach**: Generate random 7-character Base62 codes in advance and store in `key_pool` table.

**Why this approach**:
- No coordination needed between API servers (each fetches a batch)
- Random codes are not predictable (unlike sequential counters)
- Guaranteed unique (unlike hash-based that can collide)
- 62^7 = 3.5 trillion possible codes

**Implementation**:
- Background job generates 10,000 keys when pool drops below 5,000
- Each server fetches batch of 100 unused keys to local memory cache
- Keys marked `is_used=true` when URL is created

**Trade-off**: Slight complexity in key management vs. simpler counter-based approach.

### 2. Redirect Response: 302 Temporary

**Approach**: Use 302 (Temporary Redirect) instead of 301 (Permanent).

**Why this approach**:
- 301 redirects are cached by browsers, bypassing analytics
- 302 ensures every click hits our server for accurate tracking

**Trade-off**: Higher server load vs. accurate click analytics.

### 3. Caching Strategy: Cache-Aside with Redis

**Approach**: Cache-aside pattern with 24-hour TTL.

```
Read:  Check cache → if miss, query DB → populate cache → return
Write: Write to DB → write to cache (write-through)
Delete: Delete from DB → delete from cache
```

**Cache key patterns**:
- `url:{short_code}` → long_url (string, 24h TTL)
- `session:{token}` → user_id + metadata (hash, 7d TTL)
- `rate:{ip}:{endpoint}` → request count (string, 1m TTL)

**Why Redis over local cache**:
- Shared across all server instances (cache coherence)
- Built-in TTL expiration
- Atomic operations for rate limiting

### 4. Analytics: Async via Message Queue

**Approach**: Publish click events to RabbitMQ, process asynchronously.

**Why this approach**:
- Click recording shouldn't slow down redirects
- Queue provides backpressure during traffic spikes
- Worker can batch inserts for efficiency

**Queue configuration**:
- Exchange: `analytics` (direct)
- Queue: `click_events` (durable)
- Prefetch: 100 messages per worker
- Retry: 3 attempts with exponential backoff

## Technology Stack

| Layer | Technology | Version | Rationale |
|-------|------------|---------|-----------|
| **Application** | Node.js + Express | Node 20, Express 4 | Fast iteration, TypeScript support |
| **Frontend** | React + Vite | React 19, Vite 5 | Modern build tooling, fast HMR |
| **State** | Zustand + TanStack Router | Latest | Lightweight, type-safe |
| **Styling** | Tailwind CSS | v3 | Rapid UI development |
| **Database** | PostgreSQL | 16 | Reliable, great for relational data |
| **Cache** | Redis/Valkey | 7.x | Industry standard, rich data types |
| **Queue** | RabbitMQ | 3.x | Reliable delivery, easy setup |
| **Load Balancer** | nginx | Latest | Simple config, low overhead |

## Security Considerations

### Authentication and Authorization

| Mechanism | Implementation | Notes |
|-----------|----------------|-------|
| Password hashing | bcrypt (cost factor 12) | Industry standard |
| Session tokens | 256-bit random (crypto.randomBytes) | Stored in httpOnly cookie |
| Cookie settings | httpOnly, sameSite: lax, secure in prod | XSS/CSRF protection |
| Session expiration | 7 days, sliding window | Auto-extends on activity |

### Role-Based Access Control (RBAC)

```
Role: user
  - Create, view, delete own URLs
  - View own analytics
  - Manage own profile

Role: admin
  - All user permissions
  - View/delete any URL
  - View all users
  - Access system stats
  - Manage key pool
```

### Rate Limiting

| Endpoint | Limit | Window | Action |
|----------|-------|--------|--------|
| POST /api/v1/shorten | 10 | 1 minute | Per IP |
| GET /{short_code} | 100 | 1 minute | Per IP |
| POST /api/v1/auth/* | 5 | 1 minute | Per IP |
| All endpoints (authenticated) | 60 | 1 minute | Per user |

Implementation: Redis-based sliding window counter.

### Input Validation

- URL format: Valid HTTP/HTTPS URL, max 2048 characters
- Custom codes: 4-20 alphanumeric characters, no reserved words
- Reserved paths: `api`, `admin`, `auth`, `static`, `health`
- URL blacklist: Check against known malicious domains (future)

### Security Headers

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000 (production only)
Content-Security-Policy: default-src 'self'
```

## Monitoring and Observability

### Metrics (Prometheus)

```yaml
# Application metrics (exposed on /metrics)
http_requests_total{method, endpoint, status}    # Request counter
http_request_duration_seconds{method, endpoint}  # Latency histogram
url_shortening_total{status}                     # URLs created
url_redirects_total{cached}                      # Redirect counter
cache_hits_total / cache_misses_total            # Cache hit ratio
key_pool_available                               # Unused keys remaining
queue_messages_pending                           # RabbitMQ queue depth

# Infrastructure metrics (node_exporter, redis_exporter)
node_cpu_utilization
node_memory_usage_bytes
redis_connected_clients
redis_used_memory_bytes
pg_connections_active
```

### SLI Dashboards (Grafana)

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Redirect p99 latency | < 50ms | > 100ms for 5m |
| API p99 latency | < 200ms | > 500ms for 5m |
| Error rate (5xx) | < 0.1% | > 1% for 5m |
| Cache hit ratio | > 90% | < 80% for 15m |
| Key pool available | > 1000 | < 500 |
| Queue depth | < 1000 | > 5000 for 5m |

### Logging

```json
// Structured JSON logs (pino)
{
  "level": "info",
  "time": "2025-01-15T10:30:00.123Z",
  "req_id": "abc-123",
  "method": "GET",
  "path": "/abc1234",
  "status": 302,
  "duration_ms": 12,
  "cache_hit": true,
  "user_id": null
}
```

Log levels:
- `error`: Exceptions, failed requests
- `warn`: Rate limits triggered, slow queries
- `info`: Request/response, state changes
- `debug`: Detailed flow (disabled in production)

### Distributed Tracing (optional)

For learning purposes, add OpenTelemetry spans:
- `http.request` → `cache.get` → `db.query` → `queue.publish`

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Cache read/write | 1 | None | Safe (read), use SET NX |
| DB write (URL create) | 0 | N/A | Use idempotency key (short_code) |
| Queue publish | 3 | Exponential (100ms, 200ms, 400ms) | Message dedup by click_id |
| External URL validation | 2 | Linear (1s) | Safe |

### Circuit Breakers (opossum library)

```javascript
// Configuration for external services
{
  timeout: 3000,      // 3s timeout
  errorThreshold: 50, // 50% failure rate
  resetTimeout: 30000 // 30s before retry
}
```

Apply to:
- Database connection pool
- Redis client
- URL validation (HEAD request to long_url)

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Read from DB, skip caching |
| RabbitMQ down | Log click synchronously to DB |
| Key pool empty | Generate on-demand (slower) |
| DB connection pool exhausted | Return 503, queue requests |

### Backup and Recovery (Local Dev)

Since this is a learning project, simplified backup strategy:

```bash
# Daily backup script (cron)
pg_dump -h localhost -U postgres bitly > backup_$(date +%Y%m%d).sql

# Restore
psql -h localhost -U postgres bitly < backup_20250115.sql
```

For production, use pg_basebackup with WAL archiving.

## Cost Tradeoffs (Local Development)

| Resource | Local Setup | Production Equivalent | Notes |
|----------|-------------|----------------------|-------|
| PostgreSQL | Docker (free) | RDS db.t3.micro (~$15/mo) | Sufficient for learning scale |
| Redis | Docker (free) | ElastiCache t3.micro (~$12/mo) | 128MB sufficient |
| API Servers | Local Node.js | 2x t3.micro (~$16/mo) | Can scale to 0 when not testing |
| RabbitMQ | Docker (free) | AmazonMQ t3.micro (~$25/mo) | Or use SQS (~$0.40/1M requests) |

**Optimization opportunities**:
- Combine analytics writes into batches (reduce DB load by 10x)
- Use Redis pipelining for multi-key operations
- Enable PostgreSQL connection pooling (pgbouncer) at scale
- Archive old click_events to S3/MinIO for cold storage

## Scalability Considerations

### Horizontal Scaling Path

```
Phase 1: Single instance (current)
  └── PostgreSQL + Redis + RabbitMQ on Docker
  └── Single API server

Phase 2: Multi-instance local
  └── nginx load balancer (port 3000)
  └── 3 API servers (ports 3001-3003)
  └── Shared PostgreSQL + Redis + RabbitMQ

Phase 3: Read replicas (future)
  └── PostgreSQL primary + 2 read replicas
  └── Route analytics queries to replicas
  └── Redis cluster for cache partitioning

Phase 4: Sharding (future study)
  └── Shard URLs by short_code prefix (a-m, n-z)
  └── Consistent hashing for cache keys
  └── Separate analytics cluster (ClickHouse)
```

### Load Balancing Configuration

```nginx
# nginx.conf
upstream api_servers {
    least_conn;  # Route to server with fewest connections
    server localhost:3001;
    server localhost:3002;
    server localhost:3003;
}

server {
    listen 3000;

    location / {
        proxy_pass http://api_servers;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Short code generation | Pre-generated pool | Counter + Base62 | Unpredictable codes, no coordination |
| Redirect type | 302 Temporary | 301 Permanent | Accurate analytics |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Analytics storage | PostgreSQL | ClickHouse | Simpler setup for learning |
| Cache invalidation | TTL-based | Event-driven | Simpler, acceptable staleness |
| Queue | RabbitMQ | Kafka | Easier setup, sufficient for scale |

## Future Optimizations

1. **Local LRU Cache**: Add in-memory cache (lru-cache) for hot URLs before Redis
2. **Bloom Filter**: Skip DB lookup for non-existent short codes
3. **Pre-computed Analytics**: Materialize hourly/daily aggregates
4. **URL Preview**: Generate OG image previews for social sharing
5. **Bulk API**: Create multiple short URLs in single request
6. **Webhooks**: Notify external services on click thresholds
7. **Geographic Distribution**: CDN edge workers for redirect latency
8. **Malicious URL Detection**: Integrate with Google Safe Browsing API
