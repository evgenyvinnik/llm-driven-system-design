# Web Crawler - Architecture Design

## 1. Goals and Non-Goals

### Goals (v1)
- Crawl public HTML pages over HTTP(S)
- Discover and deduplicate URLs
- Obey `robots.txt` and basic politeness rules (rate limiting per domain)
- Extract page text, metadata, and outgoing links
- Scale horizontally to millions of pages
- Provide real-time observability via dashboard
- Be operable in production

### Non-Goals (v1)
- Full JavaScript rendering (SPA support deferred to v2)
- PageRank or advanced ranking algorithms
- Full-text search indexing
- Near-real-time freshness guarantees
- Anti-bot evasion or stealth crawling
- Content storage in object storage (raw HTML archival)

---

## 2. Requirements

### Functional Requirements

1. **URL Discovery**: Extract and discover new links from crawled pages
2. **Page Fetching**: Download HTML content from web servers with proper error handling
3. **Content Extraction**: Parse HTML to extract titles, descriptions, and links
4. **Politeness**: Respect robots.txt, implement per-domain rate limiting
5. **Deduplication**: Avoid crawling duplicate URLs or duplicate content
6. **Prioritization**: Crawl important pages first (seeds, shallow pages)

### Non-Functional Requirements

| Requirement | Target (Local) | Target (Production) |
|-------------|----------------|---------------------|
| Crawl rate | 10-50 pages/sec | 400+ pages/sec |
| Workers | 3-5 | 80-150 |
| Availability | Workers fail independently | 99.9% uptime |
| Dashboard latency | < 5s updates | < 1s updates |
| Consistency | Eventual (small duplicate window) | Eventual |

---

## 3. Capacity Estimation

| Metric | Local Scale | Production Scale |
|--------|-------------|------------------|
| Target crawl rate | 10-50 pages/second | 400+ pages/second |
| Workers | 3-5 | 80-150 |
| Storage per page | ~20KB compressed | ~20KB compressed |
| URL frontier size | 100K URLs | Billions of URLs |
| URL metadata | 100 bytes/URL | 100 bytes/URL |
| robots.txt cache | ~1MB | ~100GB |

---

## 4. High-Level Architecture

### System Diagram

```
                    +------------------+
                    |   Frontend       |
                    |   Dashboard      |
                    |   (React/Vite)   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   API Server     |
                    |   (Express.js)   |
                    |   Port: 3001     |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
+--------v-------+  +--------v-------+  +--------v-------+
| Fetcher        |  | Fetcher        |  | Fetcher        |
| Worker 1       |  | Worker 2       |  | Worker N       |
+-------+--------+  +--------+-------+  +--------+-------+
        |                    |                   |
        +--------------------+-------------------+
                             |
        +--------------------+--------------------+
        |                    |                    |
+-------v-------+   +--------v--------+  +--------v--------+
|  URL Frontier |   | Robots Service  |  | Parser/Link     |
|  (PostgreSQL) |   | (Redis Cache)   |  | Extractor       |
+-------+-------+   +-----------------+  +--------+--------+
        |                                         |
+-------v-------+                        +--------v--------+
| UrlTable      |                        | URL Ingestion   |
| (Metadata)    |                        | Service         |
+---------------+                        +-----------------+
        |
+-------v-------+
| Content Store |
| (Optional S3) |
+---------------+
```

### Core Components

| Component | Responsibility |
|-----------|---------------|
| **API Server** | RESTful API for dashboard, seed injection, stats |
| **Fetcher Workers** | Stateless workers that fetch pages |
| **URL Frontier** | Priority queue deciding what to crawl next |
| **Robots Service** | Fetch, cache, and query robots.txt rules |
| **Parser/Extractor** | Extract text, metadata, and links from HTML |
| **URL Ingestion** | Normalize, deduplicate, and enqueue discovered URLs |
| **UrlTable** | Central metadata store for all known URLs |
| **Content Store** | Persist fetched content (v2) |

### Data Flow

1. Seed URLs are inserted into the UrlTable with high priority
2. Frontier schedules URLs for fetching based on priority and politeness
3. Fetcher workers download HTML pages
4. Parser extracts text, metadata, and links
5. Discovered links are normalized and deduplicated
6. New URLs are added back to the frontier
7. Dashboard polls API for real-time statistics

---

## 5. URL Frontier

### Responsibilities
- Decide *what* to crawl next
- Enforce politeness (per-host rate limits)
- Track crawl state and scheduling
- Handle priority-based ordering

### Scheduling Model
- URLs are grouped by host/domain
- Each domain has:
  - Crawl delay (from robots.txt or default 1s)
  - Next-allowed-fetch timestamp
  - Lock to prevent concurrent access
- Frontier selects:
  - The highest-priority URL from an eligible domain
  - Domain must not be rate-limited

### Priority Signals

| Level | Score | Criteria |
|-------|-------|----------|
| High | 3 | Seed URLs, homepages, shallow pages (depth ≤ 2) |
| Medium | 2 | Content pages, blog posts, /about, /contact |
| Low | 1 | Paginated content, archives, deep pages |

### Implementation

```sql
-- URL Frontier: Queue of URLs to crawl
CREATE TABLE url_frontier (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL,
    priority INTEGER DEFAULT 1,      -- 1=low, 2=medium, 3=high
    depth INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, in_progress, completed, failed
    scheduled_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_frontier_priority ON url_frontier (priority DESC, scheduled_at ASC);
CREATE INDEX idx_frontier_domain ON url_frontier (domain);
CREATE INDEX idx_frontier_status ON url_frontier (status);
```

---

## 6. UrlTable (Metadata Store)

### Purpose
Central source of truth for all known URLs.

### Logical Schema

| Field | Type | Description |
|-------|------|-------------|
| url_hash | VARCHAR(64) | SHA-256 hash of normalized URL (PK) |
| normalized_url | TEXT | Canonical URL string |
| domain | VARCHAR(255) | Hostname |
| status | ENUM | never_crawled / fetched / failed / blocked |
| http_status | INTEGER | Last HTTP status code |
| last_crawled_at | TIMESTAMP | When last fetched |
| next_crawl_at | TIMESTAMP | When eligible for re-crawl |
| discovered_at | TIMESTAMP | When first seen |
| content_hash | VARCHAR(64) | Hash of extracted content |
| error_count | INTEGER | Consecutive failures |
| title | TEXT | Extracted page title |
| description | TEXT | Meta description |
| links_count | INTEGER | Number of outgoing links |

### Implementation

```sql
-- Crawled Pages: Metadata about fetched pages
CREATE TABLE crawled_pages (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL,
    status_code INTEGER,
    content_type VARCHAR(100),
    content_length INTEGER,
    content_hash VARCHAR(64),
    title TEXT,
    description TEXT,
    links_count INTEGER DEFAULT 0,
    crawled_at TIMESTAMP DEFAULT NOW(),
    crawl_duration_ms INTEGER,
    error_message TEXT
);

CREATE INDEX idx_pages_domain ON crawled_pages (domain);
CREATE INDEX idx_pages_crawled_at ON crawled_pages (crawled_at DESC);
```

---

## 7. Fetcher Workers

### Responsibilities
- Fetch HTML pages via HTTP(S)
- Respect timeouts and redirects
- Handle errors gracefully
- Update URL status in frontier

### Behavior

**Input:** FetchTask(url, domain)

**Output:**
- Success → FetchedPage(html, headers, status_code)
- Failure → ErrorEvent(url, error_type, message)

### Constraints

| Constraint | Value |
|------------|-------|
| Max redirects | 5 |
| Request timeout | 30 seconds |
| Max page size | 10 MB |
| User-Agent | Identifies crawler with contact info |

### Implementation

```typescript
interface FetchConfig {
  timeout: 30000,
  maxRedirects: 5,
  maxContentLength: 10 * 1024 * 1024,
  headers: {
    'User-Agent': 'MyCrawler/1.0 (+https://example.com/bot)',
    'Accept': 'text/html,application/xhtml+xml',
  }
}
```

---

## 8. Robots Service

### Responsibilities
- Fetch and parse `robots.txt` per domain
- Cache rules with TTL
- Answer: "Is this URL allowed for our User-Agent?"
- Extract crawl-delay directives

### Behavior

1. On first access to a domain, fetch `/robots.txt`
2. Parse and cache the result
3. Frontier queries before scheduling each URL
4. Respect crawl-delay if specified

### Caching Strategy

| Storage | TTL | Purpose |
|---------|-----|---------|
| Redis | 1 hour | Hot cache for active domains |
| PostgreSQL | Persistent | Backup and analytics |

### Implementation

```sql
-- Domains: Per-domain settings and robots.txt cache
CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) NOT NULL UNIQUE,
    robots_txt TEXT,
    robots_fetched_at TIMESTAMP,
    crawl_delay FLOAT DEFAULT 1.0,
    page_count INTEGER DEFAULT 0,
    is_allowed BOOLEAN DEFAULT true
);
```

```
# Redis keys
crawler:domain:{domain}:robots     - Cached robots.txt content
crawler:domain:{domain}:delay      - Crawl delay for domain
crawler:domain:{domain}:lock       - Rate limit lock (SET NX EX)
```

---

## 9. Parser & Link Extractor

### Responsibilities
- Parse HTML DOM
- Extract clean text and metadata
- Discover and normalize outgoing links

### Parsing Steps

1. Parse DOM with Cheerio
2. Extract:
   - `<title>` content
   - `<meta name="description">` content
   - Visible text
3. Find links:
   - `<a href="...">`
   - `<link href="...">` (canonical, alternate)
4. Resolve relative URLs to absolute
5. Drop unsupported schemes (`mailto:`, `javascript:`, `tel:`)
6. Normalize URLs
7. Deduplicate per page

### Output

```typescript
interface ParsedPage {
  title: string;
  description: string;
  text: string;
  links: string[];
  contentHash: string;
}
```

---

## 10. URL Normalization & Deduplication

### Normalization Rules

1. Lowercase scheme and host
2. Remove fragment (`#...`)
3. Normalize default ports (`:80` for HTTP, `:443` for HTTPS)
4. Sort query parameters alphabetically
5. Remove known tracking params (`utm_*`, `ref`, `source`)
6. Remove trailing slashes (optional, configurable)
7. Decode percent-encoded characters where safe

### Deduplication Strategy

**URL-level:**
- Normalize → SHA-256 hash → lookup in Redis SET
- O(1) membership check

**Content-level (v2):**
- Hash extracted text with SimHash
- Detect near-duplicate pages across URLs

### Implementation

```typescript
function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  // Lowercase
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove fragment
  parsed.hash = '';

  // Remove default ports
  if (parsed.port === '80' || parsed.port === '443') {
    parsed.port = '';
  }

  // Sort query params, remove tracking
  const params = new URLSearchParams(parsed.search);
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref'];
  trackingParams.forEach(p => params.delete(p));
  parsed.search = [...params].sort().map(([k, v]) => `${k}=${v}`).join('&');

  return parsed.toString();
}
```

```
# Redis deduplication
crawler:visited_urls    - Set of URL hashes (SADD, SISMEMBER)
```

---

## 11. URL Ingestion Service

### Responsibilities
- Consume discovered URLs from parser
- Normalize and deduplicate
- Insert new URLs into UrlTable
- Enqueue eligible URLs into Frontier

### Backpressure Controls

| Control | Value | Purpose |
|---------|-------|---------|
| Max depth | 10 | Prevent crawling infinitely deep |
| Max URLs per page | 1000 | Prevent link spam |
| Rate limit per source | 100/sec | Prevent frontier flooding |

---

## 12. Distributed Coordination

### Problem
Multiple workers must coordinate to avoid hitting the same domain concurrently.

### Solution: Redis Distributed Locks

```typescript
async function acquireDomainLock(domain: string, workerId: string, delaySeconds: number): Promise<boolean> {
  const lockKey = `crawler:domain:${domain}:lock`;
  const result = await redis.set(lockKey, workerId, 'NX', 'EX', delaySeconds);
  return result === 'OK';
}
```

### Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| Redis Locks (chosen) | Simple, auto-expiry, distributed | Slightly less efficient than central scheduler |
| Central Scheduler | Optimal scheduling | Single point of failure |
| Token Bucket | Smooth rate limiting | More complex implementation |

---

## 13. API Design

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with DB/Redis status |
| GET | `/api/stats` | Comprehensive crawl statistics |
| GET | `/api/stats/timeseries` | Time-series data for charts |
| GET | `/api/frontier/stats` | Frontier queue statistics |
| GET | `/api/frontier/urls` | List URLs in frontier |
| POST | `/api/frontier/add` | Add URLs to frontier |
| POST | `/api/frontier/seed` | Add seed URLs with high priority |
| POST | `/api/frontier/recover` | Recover stale in-progress URLs |
| GET | `/api/pages` | List crawled pages with filtering |
| GET | `/api/domains` | List crawled domains |
| GET | `/api/domains/:domain/robots` | Get cached robots.txt |

---

## 14. Observability

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `crawler_pages_fetched_total` | Counter | Total pages fetched |
| `crawler_pages_per_second` | Gauge | Current crawl rate |
| `crawler_fetch_success_rate` | Gauge | Success vs failure ratio |
| `crawler_http_status_*` | Counter | HTTP status distribution |
| `crawler_frontier_size` | Gauge | URLs pending in frontier |
| `crawler_robots_denials` | Counter | URLs blocked by robots.txt |
| `crawler_active_workers` | Gauge | Currently active workers |

### Implementation (Current)

```
# Redis stats keys
crawler:stats:pages_crawled        - Counter
crawler:stats:pages_failed         - Counter
crawler:stats:bytes_downloaded     - Counter
crawler:worker:{id}:heartbeat      - Worker last heartbeat
crawler:active_workers             - Set of active worker IDs
```

### Dashboard Updates
- Polling interval: 5 seconds
- Real-time charts for crawl rate, success rate, status codes

### Alerts (v2)

| Alert | Condition |
|-------|-----------|
| High error rate | 4xx/5xx > 20% for 5 minutes |
| Frontier backlog | Queue growing > 10% per minute |
| Worker crash | No heartbeat for 2 minutes |

---

## 15. Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Node.js | Async I/O for network-heavy workload |
| Language | TypeScript | Type safety, better tooling |
| Web Framework | Express.js | API server |
| Database | PostgreSQL | Frontier, metadata, durable storage |
| Cache | Redis/Valkey | Deduplication, locks, robots cache |
| HTML Parser | Cheerio | Fast HTML parsing without JS |
| Robots Parser | robots-parser | robots.txt parsing |
| HTTP Client | Axios | HTTP requests with timeout support |
| Frontend | React 19 + Vite | Dashboard UI |
| Routing | TanStack Router | Type-safe routing |
| State | Zustand | Lightweight state management |
| Styling | Tailwind CSS | Utility-first CSS |

---

## 16. Deployment Model

### Local Development

```bash
# Start infrastructure
docker-compose up -d postgres redis

# Start API server
npm run dev:server1

# Start workers (separate terminals)
WORKER_ID=1 npm run dev:worker
WORKER_ID=2 npm run dev:worker
WORKER_ID=3 npm run dev:worker

# Start frontend
cd frontend && npm run dev
```

### Production (Kubernetes)

- **API Server**: Deployment with 2-3 replicas, HPA
- **Workers**: Deployment with 10-100 replicas, configurable
- **PostgreSQL**: StatefulSet or managed RDS
- **Redis**: StatefulSet or ElastiCache

---

## 17. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Identification | Clear User-Agent with contact info |
| Rate limiting | Max 1 req/sec per domain by default |
| robots.txt | Always checked before crawling |
| Timeouts | 30s request timeout to prevent hanging |
| Page size | 10MB limit to prevent memory exhaustion |
| Dangerous URLs | Skip file:// and other local schemes |

### Authentication and Authorization

For this learning project, we use session-based authentication with Redis-backed sessions. This approach is simpler than JWT/OAuth and sufficient for the admin dashboard use case.

#### Authentication Flow

```
User → Login Form → POST /api/auth/login → Validate credentials → Create session → Set cookie
                                                                        ↓
                                              Redis: session:{sessionId} = { userId, role, createdAt }
```

#### Session Configuration

```typescript
// Session middleware configuration
const sessionConfig = {
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'strict'
  }
};
```

#### RBAC Boundaries

| Role | Permissions | Endpoints |
|------|-------------|-----------|
| **anonymous** | Read public stats | `GET /health`, `GET /api/stats` |
| **user** | View dashboard, read all data | `GET /api/*` |
| **admin** | Full access, modify system | `POST /api/frontier/*`, `DELETE /api/*`, `POST /api/admin/*` |

#### Admin-Only Operations

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Add seed URLs | `POST /api/frontier/seed` | Inject new crawl seeds |
| Clear frontier | `DELETE /api/frontier` | Remove all pending URLs |
| Reset domain | `POST /api/admin/domains/:domain/reset` | Re-enable blocked domain |
| Purge pages | `DELETE /api/admin/pages` | Delete crawled page data |
| Recover stale | `POST /api/frontier/recover` | Fix stuck in-progress URLs |

#### Middleware Implementation

```typescript
// Role-based access control middleware
function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.session.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Usage
app.post('/api/frontier/seed', requireRole(['admin']), seedController);
app.get('/api/stats', requireRole(['user', 'admin']), statsController);
```

### API Rate Limiting

Rate limits protect the API from abuse and ensure fair usage across clients.

| Tier | Limit | Window | Applies To |
|------|-------|--------|------------|
| Anonymous | 10 req | 1 min | Unauthenticated requests |
| User | 100 req | 1 min | Regular authenticated users |
| Admin | 500 req | 1 min | Admin operations |
| Seed injection | 10 req | 1 min | `POST /api/frontier/seed` (prevent spam) |

#### Implementation with Redis

```typescript
// Rate limiter using Redis sliding window
async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, windowStart);  // Remove old entries
  multi.zadd(key, now, `${now}-${Math.random()}`);  // Add current request
  multi.zcard(key);  // Count requests in window
  multi.expire(key, windowSeconds);  // Set TTL

  const results = await multi.exec();
  const count = results[2][1] as number;
  return count <= limit;
}

// Rate limit middleware
function rateLimit(limit: number, windowSeconds: number = 60) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `ratelimit:${req.session?.userId || req.ip}`;
    if (await checkRateLimit(key, limit, windowSeconds)) {
      next();
    } else {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter: windowSeconds });
    }
  };
}
```

---

## 18. Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Frontier storage | PostgreSQL | Kafka | Simpler, queryable, good enough for learning scale |
| Deduplication | Redis SET | Bloom Filter | Exact dedup, no false positives, acceptable memory |
| Rate limiting | Redis Lock | Token Bucket | Simpler, domain-level granularity sufficient |
| HTML parsing | Cheerio | Puppeteer | Much faster, no JS rendering needed for basic crawl |
| Priority queue | 3-level | Sorted set | Simpler to understand and debug |

---

## 19. Failure Handling and Resilience

### Retry Strategy with Idempotency

Crawl operations are inherently idempotent: fetching the same URL multiple times produces the same result. However, we need idempotency keys for internal operations to prevent duplicate processing.

#### Idempotency Key Design

```typescript
// Idempotency key for URL processing
interface IdempotencyKey {
  urlHash: string;       // SHA-256 of normalized URL
  operationType: string; // 'fetch' | 'parse' | 'ingest'
  timestamp: number;     // Unix timestamp (for deduplication window)
}

// Redis key: idempotency:{urlHash}:{operationType}
// Value: { status: 'processing' | 'completed', workerId, startedAt }
// TTL: 1 hour (allows retry after timeout)
```

#### Retry Configuration

| Operation | Max Retries | Backoff | Timeout |
|-----------|-------------|---------|---------|
| HTTP fetch | 3 | Exponential (1s, 2s, 4s) | 30s |
| robots.txt fetch | 2 | Linear (2s, 4s) | 10s |
| Database write | 3 | Exponential (100ms, 200ms, 400ms) | 5s |
| Redis operation | 3 | Fixed (100ms) | 1s |

#### Retry Implementation

```typescript
async function fetchWithRetry(url: string, options: FetchOptions): Promise<FetchResult> {
  const maxRetries = 3;
  const baseDelay = 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500, // Don't retry on 4xx
      });
      return { success: true, data: response.data, status: response.status };
    } catch (error) {
      const isRetryable = isRetryableError(error);
      const isLastAttempt = attempt === maxRetries - 1;

      if (!isRetryable || isLastAttempt) {
        return { success: false, error: error.message, attempts: attempt + 1 };
      }

      const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
      await sleep(delay + Math.random() * 500); // Add jitter
    }
  }
}

function isRetryableError(error: any): boolean {
  // Retry on network errors and 5xx responses
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
  if (error.response?.status >= 500) return true;
  return false;
}
```

### Circuit Breaker Pattern

Circuit breakers prevent cascading failures when external domains or internal services are degraded.

#### Domain-Level Circuit Breaker

```typescript
interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureAt: number;
  successCount: number;  // For half-open state
}

// Redis key: circuit:{domain}
// Configuration per domain
const circuitConfig = {
  failureThreshold: 5,       // Open after 5 consecutive failures
  resetTimeout: 60000,       // Try again after 60 seconds
  halfOpenSuccesses: 2,      // Close after 2 successes in half-open
};
```

#### Circuit Breaker Implementation

```typescript
class DomainCircuitBreaker {
  async canRequest(domain: string): Promise<boolean> {
    const state = await this.getState(domain);

    switch (state.state) {
      case 'closed':
        return true;

      case 'open':
        if (Date.now() - state.lastFailureAt > this.config.resetTimeout) {
          await this.transitionTo(domain, 'half-open');
          return true;
        }
        return false;

      case 'half-open':
        return true; // Allow limited requests
    }
  }

  async recordSuccess(domain: string): Promise<void> {
    const state = await this.getState(domain);
    if (state.state === 'half-open') {
      state.successCount++;
      if (state.successCount >= this.config.halfOpenSuccesses) {
        await this.transitionTo(domain, 'closed');
      }
    }
    state.failureCount = 0;
    await this.saveState(domain, state);
  }

  async recordFailure(domain: string): Promise<void> {
    const state = await this.getState(domain);
    state.failureCount++;
    state.lastFailureAt = Date.now();

    if (state.failureCount >= this.config.failureThreshold) {
      await this.transitionTo(domain, 'open');
    }
    await this.saveState(domain, state);
  }
}
```

### Internal Service Circuit Breakers

| Service | Failure Threshold | Reset Timeout | Action When Open |
|---------|-------------------|---------------|------------------|
| PostgreSQL | 3 failures | 30s | Queue writes to Redis, log error |
| Redis | 5 failures | 10s | Fall back to in-memory cache |
| robots.txt fetch | 3 failures | 60s | Assume disallowed, skip domain |

### Disaster Recovery (Local Development)

For a local learning project, DR focuses on data protection and quick recovery rather than multi-region failover.

#### Backup Strategy

| Component | Backup Method | Frequency | Retention |
|-----------|---------------|-----------|-----------|
| PostgreSQL | `pg_dump` | Daily | 7 days |
| Redis | RDB snapshots | Every 15 min | 24 hours |
| Configuration | Git repository | On change | Unlimited |

#### Backup Scripts

```bash
#!/bin/bash
# backup.sh - Daily backup script

BACKUP_DIR="/backups/crawler/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL backup
pg_dump -h localhost -U crawler crawler_db | gzip > "$BACKUP_DIR/postgres.sql.gz"

# Redis backup (trigger RDB save and copy)
redis-cli BGSAVE
sleep 5
cp /var/lib/redis/dump.rdb "$BACKUP_DIR/redis.rdb"

# Verify backups
gzip -t "$BACKUP_DIR/postgres.sql.gz" && echo "PostgreSQL backup verified"
redis-check-rdb "$BACKUP_DIR/redis.rdb" && echo "Redis backup verified"

# Cleanup old backups (keep 7 days)
find /backups/crawler -type d -mtime +7 -exec rm -rf {} +
```

#### Restore Procedure

```bash
#!/bin/bash
# restore.sh - Restore from backup

BACKUP_DATE=${1:-$(date +%Y-%m-%d)}
BACKUP_DIR="/backups/crawler/$BACKUP_DATE"

echo "Restoring from $BACKUP_DIR..."

# Stop workers first
pkill -f "npm run dev:worker"

# Restore PostgreSQL
gunzip -c "$BACKUP_DIR/postgres.sql.gz" | psql -h localhost -U crawler crawler_db

# Restore Redis
redis-cli SHUTDOWN NOSAVE
cp "$BACKUP_DIR/redis.rdb" /var/lib/redis/dump.rdb
redis-server /etc/redis/redis.conf

echo "Restore complete. Restart workers manually."
```

#### Recovery Testing Checklist

Run monthly to validate backup/restore procedures:

- [ ] Restore PostgreSQL backup to test database
- [ ] Verify URL frontier table row counts match
- [ ] Verify crawled_pages table integrity
- [ ] Restore Redis snapshot to test instance
- [ ] Verify visited URLs set membership
- [ ] Run health check endpoint
- [ ] Verify dashboard loads with restored data
- [ ] Document any issues and update procedures

### Worker Failure Handling

#### Heartbeat and Recovery

```typescript
// Worker heartbeat (every 30 seconds)
async function sendHeartbeat(workerId: string): Promise<void> {
  await redis.hset(`crawler:worker:${workerId}`, {
    lastHeartbeat: Date.now(),
    status: 'active',
    currentUrl: this.currentUrl || null,
  });
  await redis.expire(`crawler:worker:${workerId}`, 120); // 2-minute TTL
}

// Recovery job (runs every 5 minutes)
async function recoverStaleUrls(): Promise<number> {
  const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 minutes

  const result = await db.query(`
    UPDATE url_frontier
    SET status = 'pending', scheduled_at = NOW()
    WHERE status = 'in_progress'
    AND updated_at < $1
    RETURNING id
  `, [new Date(staleThreshold)]);

  return result.rowCount;
}
```

### Graceful Degradation

| Failure Scenario | Degradation Behavior |
|------------------|---------------------|
| PostgreSQL down | Stop accepting new URLs, continue with in-memory queue |
| Redis down | Use PostgreSQL for dedup (slower), skip rate limiting |
| Single worker crash | Other workers continue, stale URLs recovered |
| All workers crash | API server continues serving dashboard, no crawling |
| robots.txt timeout | Skip domain for 1 hour, mark as potentially blocked |

---

## 20. Data Lifecycle Policies

### Retention and TTL Configuration

Different data types have different retention requirements based on their value and storage cost.

| Data Type | Retention | TTL Mechanism | Rationale |
|-----------|-----------|---------------|-----------|
| URL frontier (pending) | Until crawled | Status change | Must crawl before deletion |
| URL frontier (completed) | 7 days | Cron job | Keep for debugging, then archive |
| URL frontier (failed) | 30 days | Cron job | Longer retention for analysis |
| Crawled pages metadata | 90 days | Cron job | Historical data for re-crawl decisions |
| Page content (if stored) | 30 days | Object lifecycle | Raw HTML is large, archive or delete |
| Visited URLs (Redis) | 24 hours | Redis TTL | Memory-bound, URLs re-discovered naturally |
| Rate limit keys | 1 minute | Redis TTL | Auto-expire after window |
| Circuit breaker state | 1 hour | Redis TTL | Reset on service restart |
| robots.txt cache | 1 hour | Redis TTL | Re-fetch periodically |
| Session data | 24 hours | Redis TTL | Force re-login daily |
| Stats/timeseries | 7 days | Cron job | Roll up to daily aggregates |

### Database Cleanup Jobs

```sql
-- cleanup_frontier.sql - Run daily via cron
-- Delete completed URLs older than 7 days
DELETE FROM url_frontier
WHERE status = 'completed'
AND updated_at < NOW() - INTERVAL '7 days';

-- Delete failed URLs older than 30 days (after export for analysis)
DELETE FROM url_frontier
WHERE status = 'failed'
AND updated_at < NOW() - INTERVAL '30 days';

-- Archive crawled pages older than 90 days
INSERT INTO crawled_pages_archive
SELECT * FROM crawled_pages
WHERE crawled_at < NOW() - INTERVAL '90 days';

DELETE FROM crawled_pages
WHERE crawled_at < NOW() - INTERVAL '90 days';

-- Vacuum to reclaim space (run weekly)
VACUUM ANALYZE url_frontier;
VACUUM ANALYZE crawled_pages;
```

### Cron Schedule

```bash
# /etc/cron.d/crawler-maintenance

# Daily cleanup at 3 AM
0 3 * * * crawler psql -f /app/scripts/cleanup_frontier.sql

# Weekly vacuum at 4 AM Sunday
0 4 * * 0 crawler psql -c "VACUUM ANALYZE;"

# Archive stats daily at midnight
0 0 * * * crawler /app/scripts/archive_stats.sh

# Backup at 2 AM daily
0 2 * * * crawler /app/scripts/backup.sh
```

### Archival to Cold Storage

For a local development setup, "cold storage" means compressed files on disk. In production, this would be S3 Glacier or similar.

#### Archive Strategy

| Data | Archive Format | Storage Location | Compression |
|------|---------------|------------------|-------------|
| Crawled pages | PostgreSQL COPY | `/archive/pages/` | gzip |
| Failed URLs | CSV export | `/archive/failures/` | gzip |
| Stats rollups | JSON | `/archive/stats/` | gzip |

#### Archive Script

```bash
#!/bin/bash
# archive_old_data.sh - Monthly archive job

ARCHIVE_DATE=$(date -d "90 days ago" +%Y-%m)
ARCHIVE_DIR="/archive/crawler/$ARCHIVE_DATE"
mkdir -p "$ARCHIVE_DIR"

# Export crawled pages to archive
psql -h localhost -U crawler crawler_db -c "
  COPY (
    SELECT * FROM crawled_pages
    WHERE crawled_at < NOW() - INTERVAL '90 days'
  ) TO STDOUT WITH CSV HEADER
" | gzip > "$ARCHIVE_DIR/crawled_pages.csv.gz"

# Export failed URLs with error analysis
psql -h localhost -U crawler crawler_db -c "
  COPY (
    SELECT url, domain, error_message, created_at, updated_at
    FROM url_frontier
    WHERE status = 'failed'
    AND updated_at < NOW() - INTERVAL '30 days'
  ) TO STDOUT WITH CSV HEADER
" | gzip > "$ARCHIVE_DIR/failed_urls.csv.gz"

echo "Archived data to $ARCHIVE_DIR"

# Optional: Upload to S3 if configured
if [ -n "$AWS_BUCKET" ]; then
  aws s3 sync "$ARCHIVE_DIR" "s3://$AWS_BUCKET/archive/$ARCHIVE_DATE/"
fi
```

### Backfill and Replay Procedures

Backfill is needed when re-processing historical data or recovering from data loss.

#### Backfill Scenarios

| Scenario | Trigger | Procedure |
|----------|---------|-----------|
| Schema migration | Added new extracted field | Re-crawl and re-parse stored HTML |
| Lost Redis data | Redis crash without backup | Rebuild visited set from PostgreSQL |
| Partial crawl loss | Worker crash mid-batch | Recover stale URLs via API |
| Index rebuild | Elasticsearch reindex | Replay from crawled_pages table |

#### Rebuild Visited URLs from PostgreSQL

```typescript
// backfill_visited_urls.ts
// Rebuilds Redis visited set from PostgreSQL if Redis data is lost

async function rebuildVisitedUrls(): Promise<number> {
  console.log('Rebuilding visited URLs from PostgreSQL...');

  // Stream URLs from database to avoid memory issues
  const batchSize = 10000;
  let offset = 0;
  let total = 0;

  while (true) {
    const result = await db.query(`
      SELECT url_hash FROM crawled_pages
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [batchSize, offset]);

    if (result.rows.length === 0) break;

    // Add to Redis in batches
    const pipeline = redis.pipeline();
    for (const row of result.rows) {
      pipeline.sadd('crawler:visited_urls', row.url_hash);
    }
    await pipeline.exec();

    total += result.rows.length;
    offset += batchSize;
    console.log(`Processed ${total} URLs...`);
  }

  console.log(`Rebuilt visited set with ${total} URLs`);
  return total;
}
```

#### Replay Crawled Pages for Reprocessing

```typescript
// replay_pages.ts
// Re-processes stored pages when parsing logic changes

interface ReplayOptions {
  startDate?: Date;
  endDate?: Date;
  domain?: string;
  dryRun?: boolean;
}

async function replayPages(options: ReplayOptions): Promise<void> {
  const whereClause = [];
  const params = [];

  if (options.startDate) {
    params.push(options.startDate);
    whereClause.push(`crawled_at >= $${params.length}`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    whereClause.push(`crawled_at <= $${params.length}`);
  }
  if (options.domain) {
    params.push(options.domain);
    whereClause.push(`domain = $${params.length}`);
  }

  const where = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT COUNT(*) FROM crawled_pages ${where}`, params);
  console.log(`Found ${countResult.rows[0].count} pages to replay`);

  if (options.dryRun) {
    console.log('Dry run - no changes made');
    return;
  }

  // Re-queue pages for re-processing
  await db.query(`
    INSERT INTO url_frontier (url, url_hash, domain, priority, status, scheduled_at)
    SELECT url, url_hash, domain, 2, 'pending', NOW()
    FROM crawled_pages ${where}
    ON CONFLICT (url_hash) DO UPDATE SET
      status = 'pending',
      scheduled_at = NOW()
  `, params);

  console.log('Pages queued for replay');
}
```

#### Backfill from Archive

```bash
#!/bin/bash
# restore_from_archive.sh - Restore archived data for analysis

ARCHIVE_DATE=${1:?"Usage: restore_from_archive.sh YYYY-MM"}
ARCHIVE_DIR="/archive/crawler/$ARCHIVE_DATE"

if [ ! -d "$ARCHIVE_DIR" ]; then
  echo "Archive not found: $ARCHIVE_DIR"
  exit 1
fi

# Create temporary table for archived data
psql -h localhost -U crawler crawler_db -c "
  CREATE TABLE IF NOT EXISTS crawled_pages_restore (LIKE crawled_pages);
"

# Load archived data
gunzip -c "$ARCHIVE_DIR/crawled_pages.csv.gz" | \
  psql -h localhost -U crawler crawler_db -c "
    COPY crawled_pages_restore FROM STDIN WITH CSV HEADER;
  "

echo "Restored $(psql -t -c 'SELECT COUNT(*) FROM crawled_pages_restore') pages"
echo "Data available in crawled_pages_restore table"
echo "Run 'DROP TABLE crawled_pages_restore' when done"
```

### Storage Growth Monitoring

```sql
-- storage_report.sql - Monthly storage report

SELECT
  'url_frontier' as table_name,
  pg_size_pretty(pg_total_relation_size('url_frontier')) as total_size,
  (SELECT COUNT(*) FROM url_frontier) as row_count,
  (SELECT COUNT(*) FROM url_frontier WHERE status = 'pending') as pending,
  (SELECT COUNT(*) FROM url_frontier WHERE status = 'completed') as completed,
  (SELECT COUNT(*) FROM url_frontier WHERE status = 'failed') as failed
UNION ALL
SELECT
  'crawled_pages',
  pg_size_pretty(pg_total_relation_size('crawled_pages')),
  (SELECT COUNT(*) FROM crawled_pages),
  NULL, NULL, NULL
UNION ALL
SELECT
  'domains',
  pg_size_pretty(pg_total_relation_size('domains')),
  (SELECT COUNT(*) FROM domains),
  NULL, NULL, NULL;
```

---

## 21. Future Extensions (v2+)

| Feature | Description |
|---------|-------------|
| JavaScript rendering | Puppeteer/Playwright pool for SPA sites |
| Near-duplicate detection | SimHash for content similarity |
| Content storage | S3/HDFS for raw HTML archival |
| Sitemap parsing | Extract URLs from sitemap.xml |
| Adaptive scheduling | Learn optimal crawl frequency per domain |
| Link graph storage | Store and analyze link relationships |
| Search indexing | Elasticsearch integration for full-text search |
| Work stealing | Dynamic rebalancing when workers are idle |
| DNS caching | Reduce DNS lookups for repeated domains |
| Per-site configurations | Custom rules for specific domains |

---

## 22. Summary

This v1 crawler:
- Is simple but production-shaped
- Scales horizontally with stateless workers
- Obeys web norms (robots.txt, politeness)
- Produces clean text and a growing URL frontier
- Provides real-time observability via dashboard

It forms a solid foundation for more advanced crawling systems while being runnable on a single laptop for learning purposes.
