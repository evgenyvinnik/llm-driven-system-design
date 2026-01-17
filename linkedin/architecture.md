# Design LinkedIn - Architecture

## System Overview

LinkedIn is a professional social network where users build career profiles, connect with colleagues, and discover job opportunities. Core challenges involve graph traversal for connections and multi-factor recommendation algorithms.

**Learning Goals:**
- Design efficient social graph storage and traversal
- Build recommendation engines (PYMK, job matching)
- Implement feed ranking with multiple signals
- Handle company-employee relationships

---

## Requirements

### Functional Requirements

1. **Profiles**: Professional history, skills, education
2. **Connections**: Request, accept, view network
3. **Feed**: Posts from connections, ranked by relevance
4. **Jobs**: Post listings, apply, match candidates
5. **Search**: Find people, companies, jobs

### Non-Functional Requirements

- **Latency**: < 200ms for feed, < 500ms for PYMK
- **Scale**: 900M users, 100B connections
- **Availability**: 99.9% uptime
- **Consistency**: Eventual for feed, strong for connections

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│              React + Professional UI Components                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                              │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Profile Service│    │ Graph Service │    │  Job Service  │
│               │    │               │    │               │
│ - CRUD profile│    │ - Connections │    │ - Listings    │
│ - Skills      │    │ - Degrees     │    │ - Matching    │
│ - Experience  │    │ - PYMK        │    │ - Applications│
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Graph Store     │    Elasticsearch          │
│   - Profiles    │   - Connections   │    - Profile search       │
│   - Jobs        │   - Traversals    │    - Job search           │
│   - Companies   │   (Neo4j or       │    - Skill matching       │
│                 │   PostgreSQL)     │                           │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Connection Degrees

**Challenge**: Given user A, find all 2nd-degree connections efficiently

**Approach 1: SQL Recursive CTE**
```sql
WITH RECURSIVE connection_degrees AS (
  -- First degree
  SELECT connected_to as user_id, 1 as degree
  FROM connections WHERE user_id = $1

  UNION

  -- Second degree
  SELECT c.connected_to, cd.degree + 1
  FROM connections c
  JOIN connection_degrees cd ON c.user_id = cd.user_id
  WHERE cd.degree < 2
)
SELECT DISTINCT user_id, MIN(degree) as degree
FROM connection_degrees
GROUP BY user_id;
```

**Approach 2: Graph Database (Neo4j)**
```cypher
MATCH (me:User {id: $userId})-[:CONNECTED*1..2]-(other:User)
WHERE other.id <> $userId
RETURN other.id, min(length(path)) as degree
```

**Approach 3: Precomputed + Cache (Chosen for scale)**
- Precompute 2nd-degree connections nightly
- Store in Valkey sorted sets
- Refresh incrementally on new connections

### 2. People You May Know (PYMK)

**Scoring Factors:**
```javascript
function pymkScore(userId, candidateId) {
  let score = 0

  // Mutual connections (strongest signal)
  const mutuals = getMutualConnections(userId, candidateId)
  score += mutuals.length * 10

  // Same company (current or past)
  if (sameCompany(userId, candidateId)) score += 8

  // Same school
  if (sameSchool(userId, candidateId)) score += 5

  // Shared skills
  const sharedSkills = getSharedSkills(userId, candidateId)
  score += sharedSkills.length * 2

  // Same industry
  if (sameIndustry(userId, candidateId)) score += 3

  // Geographic proximity
  if (sameLocation(userId, candidateId)) score += 2

  return score
}
```

**Batch Processing:**
- Run PYMK calculation daily in background
- Store top 100 candidates per user
- Invalidate on new connections

### 3. Job-Candidate Matching

**Multi-Factor Scoring:**
```javascript
function jobMatchScore(job, candidate) {
  let score = 0

  // Required skills match
  const requiredSkills = job.requiredSkills
  const candidateSkills = candidate.skills
  const skillMatch = intersection(requiredSkills, candidateSkills).length
  score += (skillMatch / requiredSkills.length) * 40

  // Experience level
  const expMatch = Math.abs(job.yearsRequired - candidate.yearsExperience)
  score += Math.max(0, 25 - expMatch * 5)

  // Location compatibility
  if (job.remote || sameLocation(job, candidate)) score += 15

  // Education match
  if (educationMeets(job.education, candidate.education)) score += 10

  // Company connection (knows someone there)
  if (hasConnectionAtCompany(candidate, job.companyId)) score += 10

  return score
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  headline VARCHAR(200),
  location VARCHAR(100),
  industry VARCHAR(100),
  connection_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Experience
CREATE TABLE experiences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  company_id INTEGER REFERENCES companies(id),
  title VARCHAR(200),
  start_date DATE,
  end_date DATE,
  description TEXT,
  is_current BOOLEAN DEFAULT FALSE
);

-- Connections
CREATE TABLE connections (
  user_id INTEGER REFERENCES users(id),
  connected_to INTEGER REFERENCES users(id),
  connected_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, connected_to)
);

-- Skills
CREATE TABLE skills (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE
);

CREATE TABLE user_skills (
  user_id INTEGER REFERENCES users(id),
  skill_id INTEGER REFERENCES skills(id),
  endorsement_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, skill_id)
);

-- Jobs
CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  title VARCHAR(200),
  description TEXT,
  location VARCHAR(100),
  is_remote BOOLEAN DEFAULT FALSE,
  years_required INTEGER,
  required_skills INTEGER[],
  posted_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Hybrid Graph Storage

**Decision**: PostgreSQL for profile data, optional Neo4j for deep traversals

**Rationale**:
- Most queries are 1-2 hops (efficient in SQL)
- Neo4j for complex PYMK calculations (optional)
- Keeps primary stack simple

### 2. Precomputed Recommendations

**Decision**: Batch compute PYMK and job matches offline

**Rationale**:
- Expensive calculations (millions of comparisons)
- Results don't need real-time freshness
- Cache invalidated on relevant changes

### 3. Skills as First-Class Entities

**Decision**: Normalized skills table with endorsements

**Rationale**:
- Enables skill-based search and matching
- Standardizes skill names across users
- Supports endorsement counting

---

## Async Processing and Message Queues

For background jobs, fanout operations, and handling backpressure, we use RabbitMQ with well-defined delivery semantics.

### Queue Architecture

```
┌──────────────┐     ┌─────────────────────────────────────────────────────┐
│ API Services │────▶│                    RabbitMQ                         │
└──────────────┘     ├─────────────────────────────────────────────────────┤
                     │  Exchanges:                                          │
                     │  ├── linkedin.direct (direct)                        │
                     │  ├── linkedin.fanout (fanout)                        │
                     │  └── linkedin.topic (topic)                          │
                     ├─────────────────────────────────────────────────────┤
                     │  Queues:                                             │
                     │  ├── pymk.compute (PYMK batch jobs)                  │
                     │  ├── feed.generate (feed building)                   │
                     │  ├── notifications (email/push)                      │
                     │  ├── search.index (Elasticsearch sync)               │
                     │  └── jobs.match (candidate matching)                 │
                     └─────────────────────────────────────────────────────┘
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
              ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
              │PYMK Worker  │     │Feed Worker  │     │Index Worker │
              └─────────────┘     └─────────────┘     └─────────────┘
```

### Queue Definitions and Use Cases

| Queue | Purpose | Delivery | Concurrency | Retry Policy |
|-------|---------|----------|-------------|--------------|
| `pymk.compute` | Recalculate PYMK for a user | At-least-once | 2 workers | 3 retries, exponential backoff |
| `feed.generate` | Build personalized feed | At-least-once | 3 workers | 5 retries, 30s delay |
| `notifications` | Send emails, push notifications | At-least-once | 5 workers | 3 retries, then dead-letter |
| `search.index` | Sync profile/job changes to Elasticsearch | At-least-once | 2 workers | Infinite retries, 60s delay |
| `jobs.match` | Match candidates to new job postings | At-least-once | 2 workers | 3 retries |

### Message Schemas

```typescript
// Connection event - triggers PYMK recalculation and feed updates
interface ConnectionEvent {
  type: 'connection.created' | 'connection.removed';
  userId: string;
  connectedUserId: string;
  timestamp: string; // ISO 8601
  idempotencyKey: string; // UUID for deduplication
}

// Profile update - triggers search index update
interface ProfileUpdateEvent {
  type: 'profile.updated';
  userId: string;
  changedFields: string[]; // ['headline', 'skills', 'experience']
  timestamp: string;
  idempotencyKey: string;
}

// Job posted - triggers candidate matching
interface JobPostedEvent {
  type: 'job.posted';
  jobId: string;
  companyId: string;
  requiredSkills: string[];
  timestamp: string;
  idempotencyKey: string;
}
```

### Delivery Semantics

**At-Least-Once Delivery** (chosen for all queues):
- Messages are acknowledged only after successful processing
- Workers must be idempotent (use `idempotencyKey` to detect duplicates)
- Idempotency tracking stored in Valkey with 24-hour TTL

```typescript
// Idempotent message processing
async function processMessage(message: ConnectionEvent) {
  const idempotencyKey = `processed:${message.idempotencyKey}`;

  // Check if already processed
  const alreadyProcessed = await valkey.get(idempotencyKey);
  if (alreadyProcessed) {
    return; // Skip duplicate
  }

  // Process the message
  await recalculatePYMK(message.userId);

  // Mark as processed (24-hour TTL)
  await valkey.setex(idempotencyKey, 86400, 'true');
}
```

### Backpressure Handling

1. **Prefetch Limit**: Each worker prefetches at most 10 messages
2. **Queue Length Alerts**: Alert when queue depth exceeds 1000 messages
3. **Dead Letter Queue**: Failed messages after max retries go to `*.dlq` queues
4. **Consumer Scaling**: Workers can be scaled horizontally (2-5 instances locally)

### Local Development Setup

```bash
# Start RabbitMQ with management UI
docker run -d --name rabbitmq \
  -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=linkedin \
  -e RABBITMQ_DEFAULT_PASS=linkedin123 \
  rabbitmq:3-management

# Management UI available at http://localhost:15672
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication Strategy

**Session-Based Authentication** (chosen for simplicity in local development):

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│ Client  │────▶│ API Gateway │────▶│ Auth Service│────▶│ Valkey  │
└─────────┘     └─────────────┘     └─────────────┘     └─────────┘
     │                                     │
     │  Cookie: session_id=abc123          │  Session lookup
     │◀────────────────────────────────────│  user:session:abc123
```

### Session Management

```typescript
// Session stored in Valkey
interface Session {
  userId: string;
  email: string;
  role: 'user' | 'recruiter' | 'admin';
  permissions: string[];
  createdAt: string;
  lastAccessedAt: string;
  ipAddress: string;
  userAgent: string;
}

// Session TTL: 7 days, sliding expiration
// Key format: user:session:{sessionId}
```

**Login Flow:**
1. User submits email/password to `POST /api/v1/auth/login`
2. Server validates credentials against bcrypt hash in PostgreSQL
3. Server creates session in Valkey with 7-day TTL
4. Server sets HttpOnly, Secure, SameSite=Strict cookie with session ID
5. Subsequent requests include cookie automatically

### Role-Based Access Control (RBAC)

| Role | Description | Permissions |
|------|-------------|-------------|
| `user` | Standard LinkedIn user | `profile:read`, `profile:write:own`, `connection:*`, `feed:read`, `job:apply` |
| `recruiter` | Company recruiter | All user permissions + `job:post`, `job:manage:own`, `candidate:search` |
| `admin` | Platform administrator | All permissions + `user:manage`, `content:moderate`, `analytics:view` |

### Permission Checks

```typescript
// Middleware for route protection
function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req.cookies.session_id);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!session.permissions.includes(permission)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = session;
    next();
  };
}

// Route examples
app.get('/api/v1/profile/:id', requirePermission('profile:read'), getProfile);
app.put('/api/v1/profile/:id', requirePermission('profile:write:own'), updateProfile);
app.post('/api/v1/admin/users/:id/ban', requirePermission('user:manage'), banUser);
```

### API Endpoint Authorization Matrix

| Endpoint | user | recruiter | admin |
|----------|------|-----------|-------|
| `GET /api/v1/profile/:id` | Yes | Yes | Yes |
| `PUT /api/v1/profile/:id` | Own only | Own only | Any |
| `POST /api/v1/connections` | Yes | Yes | Yes |
| `POST /api/v1/jobs` | No | Yes | Yes |
| `GET /api/v1/jobs/:id/candidates` | No | Own jobs | Any |
| `GET /api/v1/admin/users` | No | No | Yes |
| `POST /api/v1/admin/users/:id/ban` | No | No | Yes |
| `GET /api/v1/admin/analytics` | No | No | Yes |

### Rate Limiting

**Strategy**: Token bucket algorithm implemented in Valkey

| Endpoint Category | Rate Limit | Bucket Size | Refill Rate |
|-------------------|------------|-------------|-------------|
| Public (login, signup) | 10 req/min | 10 | 1 token/6s |
| Authenticated reads | 100 req/min | 100 | ~1.6 token/s |
| Authenticated writes | 30 req/min | 30 | 0.5 token/s |
| Search | 20 req/min | 20 | 0.33 token/s |
| Admin endpoints | 60 req/min | 60 | 1 token/s |

```typescript
// Rate limiter implementation
async function checkRateLimit(userId: string, category: string): Promise<boolean> {
  const key = `ratelimit:${category}:${userId}`;
  const limit = RATE_LIMITS[category];

  const current = await valkey.incr(key);
  if (current === 1) {
    await valkey.expire(key, 60); // Reset every minute
  }

  return current <= limit.requestsPerMinute;
}

// Response headers
res.setHeader('X-RateLimit-Limit', limit.requestsPerMinute);
res.setHeader('X-RateLimit-Remaining', Math.max(0, limit.requestsPerMinute - current));
res.setHeader('X-RateLimit-Reset', resetTimestamp);
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Track:**

| Metric Name | Type | Description | Labels |
|-------------|------|-------------|--------|
| `http_requests_total` | Counter | Total HTTP requests | `method`, `path`, `status` |
| `http_request_duration_seconds` | Histogram | Request latency | `method`, `path` |
| `active_sessions` | Gauge | Current active sessions | - |
| `connections_created_total` | Counter | New connections made | - |
| `pymk_computation_duration_seconds` | Histogram | PYMK batch job duration | `user_network_size` |
| `feed_generation_duration_seconds` | Histogram | Feed build time | - |
| `queue_depth` | Gauge | Messages waiting in queue | `queue_name` |
| `queue_processing_duration_seconds` | Histogram | Message processing time | `queue_name` |
| `db_query_duration_seconds` | Histogram | Database query time | `query_type` |
| `cache_hits_total` | Counter | Valkey cache hits | `cache_name` |
| `cache_misses_total` | Counter | Valkey cache misses | `cache_name` |
| `elasticsearch_query_duration_seconds` | Histogram | Search query time | `index` |

**Prometheus Configuration (prometheus.yml):**

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'linkedin-api'
    static_configs:
      - targets: ['localhost:3001', 'localhost:3002', 'localhost:3003']

  - job_name: 'linkedin-workers'
    static_configs:
      - targets: ['localhost:3010', 'localhost:3011']

  - job_name: 'rabbitmq'
    static_configs:
      - targets: ['localhost:15692']  # RabbitMQ Prometheus plugin

  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']  # postgres_exporter
```

### Logging (Structured JSON)

**Log Format:**

```typescript
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;        // 'api', 'pymk-worker', 'feed-worker'
  traceId: string;        // For request correlation
  spanId: string;
  userId?: string;        // If authenticated
  message: string;
  context: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack: string;
  };
}
```

**Example Log Entries:**

```json
{"timestamp":"2025-01-15T10:23:45.123Z","level":"info","service":"api","traceId":"abc123","spanId":"def456","userId":"user_789","message":"Connection request sent","context":{"targetUserId":"user_012","mutualConnections":5}}

{"timestamp":"2025-01-15T10:23:46.456Z","level":"error","service":"pymk-worker","traceId":"ghi789","spanId":"jkl012","message":"PYMK computation failed","context":{"userId":"user_789","networkSize":5000},"error":{"name":"TimeoutError","message":"Query exceeded 30s limit","stack":"..."}}
```

**Log Levels by Environment:**

| Environment | Min Level | Destinations |
|-------------|-----------|--------------|
| Development | debug | Console (pretty-printed) |
| Local Docker | info | Console (JSON), file |
| Production | info | Log aggregator (Loki/ELK) |

### Distributed Tracing

**Trace Propagation:**

```typescript
// Express middleware to extract/create trace context
function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = req.headers['x-trace-id'] || crypto.randomUUID();
  const spanId = crypto.randomUUID();

  req.traceContext = { traceId, spanId, parentSpanId: req.headers['x-span-id'] };
  res.setHeader('X-Trace-Id', traceId);

  next();
}

// Propagate to downstream services and workers
async function publishToQueue(queue: string, message: any, traceContext: TraceContext) {
  await channel.sendToQueue(queue, Buffer.from(JSON.stringify({
    ...message,
    _trace: traceContext
  })));
}
```

### SLI/SLO Dashboard

**Service Level Indicators:**

| SLI | Target (SLO) | Measurement |
|-----|--------------|-------------|
| Feed API latency (p99) | < 200ms | `histogram_quantile(0.99, http_request_duration_seconds{path="/api/v1/feed"})` |
| PYMK API latency (p99) | < 500ms | `histogram_quantile(0.99, http_request_duration_seconds{path="/api/v1/pymk"})` |
| API availability | 99.9% | `sum(rate(http_requests_total{status!~"5.."})) / sum(rate(http_requests_total))` |
| Connection request success rate | 99.5% | `sum(rate(http_requests_total{path="/api/v1/connections",status="201"})) / sum(rate(http_requests_total{path="/api/v1/connections"}))` |
| Cache hit ratio | > 80% | `sum(cache_hits_total) / (sum(cache_hits_total) + sum(cache_misses_total))` |
| Queue processing lag | < 30s | `max(queue_depth) / avg(rate(queue_processing_duration_seconds_count))` |

**Grafana Dashboard Panels:**

1. **Overview Row**: Request rate, error rate, p50/p95/p99 latency
2. **API Breakdown**: Latency by endpoint, top 5 slowest endpoints
3. **Cache Performance**: Hit/miss ratio, cache size, evictions
4. **Queue Health**: Depth per queue, processing rate, dead letters
5. **Database**: Query latency, connection pool usage, slow queries
6. **Business Metrics**: New connections/hour, jobs posted, PYMK clicks

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Error Rate | `rate(http_requests_total{status=~"5.."}[5m]) > 0.01` | Critical | Page on-call |
| API Latency Spike | `histogram_quantile(0.99, http_request_duration_seconds[5m]) > 1` | Warning | Investigate |
| Queue Backup | `queue_depth{queue_name="feed.generate"} > 5000` | Warning | Scale workers |
| Dead Letters | `rate(queue_depth{queue_name=~".*dlq"}[1h]) > 10` | Warning | Review failures |
| Low Cache Hit Ratio | `cache_hit_ratio < 0.7` | Warning | Check cache config |
| Database Connection Pool Exhausted | `db_pool_available < 5` | Critical | Scale connections |
| Disk Space Low | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1` | Warning | Clean up or expand |

**Alert Configuration (Prometheus rules):**

```yaml
groups:
  - name: linkedin-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes"

      - alert: FeedLatencyHigh
        expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{path="/api/v1/feed"}[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Feed API p99 latency exceeds 500ms"
```

### Audit Logging

**Auditable Events:**

| Event | Logged Fields | Retention |
|-------|--------------|-----------|
| Login success/failure | userId, email, ipAddress, userAgent, success | 90 days |
| Profile update | userId, changedFields, previousValues (hashed), newValues (hashed) | 1 year |
| Connection request sent/accepted | userId, targetUserId, action | 1 year |
| Job posted/updated/deleted | recruiterId, jobId, companyId, action | 2 years |
| Admin action | adminUserId, targetUserId, action, reason | 5 years |
| Permission change | adminUserId, targetUserId, oldRole, newRole | 5 years |

**Audit Log Schema:**

```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  actor_ip INET,
  target_type VARCHAR(50),  -- 'user', 'job', 'connection'
  target_id INTEGER,
  action VARCHAR(50) NOT NULL,
  details JSONB,            -- Event-specific data
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for compliance queries
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type, created_at);
```

**Audit Log Query Examples:**

```sql
-- All admin actions in the last 30 days
SELECT * FROM audit_logs
WHERE event_type LIKE 'admin.%'
AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;

-- All changes to a specific user's profile
SELECT * FROM audit_logs
WHERE target_type = 'user' AND target_id = 12345
ORDER BY created_at DESC;
```

### Local Observability Stack

```bash
# Start Prometheus + Grafana for local development
docker-compose -f docker-compose.observability.yml up -d

# docker-compose.observability.yml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - ./grafana/dashboards:/var/lib/grafana/dashboards

  loki:
    image: grafana/loki:2.9.0
    ports:
      - "3100:3100"
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Graph storage | PostgreSQL + cache | Neo4j | Simplicity |
| PYMK | Batch precompute | Real-time | Cost efficiency |
| Search | Elasticsearch | PostgreSQL FTS | Better relevance |
| Skills | Normalized table | JSON array | Queryable, standardized |
| Message Queue | RabbitMQ | Kafka | Simpler ops, sufficient for batch jobs |
| Auth | Session + Valkey | JWT | Simpler revocation, less client complexity |
| Rate Limiting | Token bucket in Valkey | Fixed window | Smoother traffic, burst tolerance |
| Observability | Prometheus + Grafana | Datadog/New Relic | Free, self-hosted, learning-focused |

---

## Implementation Notes

This section documents the rationale behind key implementation decisions for the LinkedIn clone's backend infrastructure.

### Why Async Queues Enable Efficient Feed Fanout

When a user creates a post, their content needs to appear in the feeds of all their connections. For a user with 500+ connections, synchronously updating all those feeds would:

1. **Block the API response** - The user would wait seconds for the post to publish
2. **Create thundering herd problems** - Cache invalidation for 500 feeds simultaneously overwhelms Redis
3. **Risk partial failures** - If the 300th cache update fails, is the post published or not?

**RabbitMQ solves this by decoupling the publish from the fanout:**

```
User creates post -> API returns immediately -> Message queued
                                                      |
                                                      v
                              Worker processes at controlled rate
                              (10 connections/second, not 500 at once)
```

The queue provides:
- **Backpressure handling**: Workers process at sustainable rates
- **Retry semantics**: Failed fanouts retry with exponential backoff
- **Observability**: Queue depth metrics alert when fanout falls behind
- **Idempotency**: Deduplication keys prevent duplicate notifications

For PYMK (People You May Know) recalculation, which can take 30+ seconds for users with large networks, async processing is essential. The queue allows batch computation during off-peak hours without blocking the main API.

### Why Rate Limiting Prevents Spam Connection Requests

LinkedIn's connection request feature is a prime target for spam:

1. **Recruiters** may blast connection requests to thousands of candidates
2. **Bots** harvest connection graphs for lead generation
3. **Bad actors** send malicious links in connection messages

Without rate limiting, a single user could send 10,000 connection requests per hour, creating:
- Notification fatigue for recipients
- Database load from pending request storage
- Reputation damage to the platform

**Our token bucket implementation provides:**

| Endpoint | Limit | Burst | Rationale |
|----------|-------|-------|-----------|
| Connection requests | 20/min | 10 | Prevents spam while allowing normal networking |
| Profile updates | 30/min | 30 | Generous for editing, prevents abuse |
| Search queries | 20/min | 20 | Protects Elasticsearch from query storms |
| Login attempts | 10/min | 10 | Mitigates credential stuffing attacks |

The token bucket algorithm (vs. fixed window) provides smoother traffic patterns:
- A user can burst 10 requests instantly, then must wait
- Tokens refill gradually, not all-at-once at window boundaries
- More predictable load on downstream services

Rate limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) allow well-behaved clients to back off gracefully before hitting limits.

### Why Audit Logging Enables Account Recovery and Security

Professional networks contain sensitive career data. Audit logging serves multiple critical functions:

**1. Account Recovery**
When a user reports their profile was changed without their knowledge:
```sql
SELECT * FROM audit_logs
WHERE target_type = 'profile' AND target_id = 12345
AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```
This reveals exactly what changed, when, and from which IP address, enabling:
- Identification of unauthorized access
- Restoration of previous profile state
- Evidence for security investigations

**2. Compliance Requirements**
Professional platforms may need to demonstrate:
- Who accessed candidate data (GDPR data subject requests)
- When admin actions were taken (SOC 2 audits)
- Login history for compromised account investigations

**3. Security Monitoring**
Audit logs enable detection of:
- Credential stuffing (many failed logins from one IP)
- Account takeover (login from unusual location)
- Privilege escalation (role changes)

**What we log:**
| Event Type | Retention | Purpose |
|------------|-----------|---------|
| Login success/failure | 90 days | Security monitoring |
| Profile updates | 1 year | Account recovery |
| Connection events | 1 year | Network integrity |
| Admin actions | 5 years | Compliance |

**Privacy considerations:**
- Sensitive field values are masked (showing only first/last 2 characters)
- IP addresses are stored for security but not exposed to users
- Audit logs are append-only (no UPDATE/DELETE access)

### Why Metrics Enable Engagement Optimization

LinkedIn's business model depends on user engagement. Prometheus metrics enable data-driven optimization:

**1. Performance SLOs**
```yaml
# Alert when feed generation exceeds 500ms p99
- alert: FeedLatencyHigh
  expr: histogram_quantile(0.99, rate(feed_generation_duration_seconds_bucket[5m])) > 0.5
```
Slow feeds reduce scroll engagement. Metrics identify performance regressions before users complain.

**2. Feature Adoption**
```promql
# Track connection request conversion rate
rate(connections_created_total[1h]) / rate(connection_requests_total[1h])
```
This reveals whether PYMK algorithm changes improve actual connection formation.

**3. Capacity Planning**
```promql
# Predict when we'll exceed queue capacity
predict_linear(queue_depth{queue_name="notifications"}[1h], 3600)
```
Queue depth trends indicate when to scale notification workers.

**4. Business Metrics**
| Metric | What It Reveals |
|--------|-----------------|
| `posts_created_total` | Content creation health |
| `profile_views_total` | Job seeker activity |
| `post_likes_total` | Feed engagement quality |
| `pymk_computation_duration_seconds` | Algorithm efficiency |

**Key Prometheus patterns used:**
- **Counters** for monotonically increasing values (requests, errors)
- **Histograms** for latency distributions (p50, p95, p99)
- **Gauges** for current state (queue depth, active sessions)

The `/metrics` endpoint exposes all metrics in Prometheus format, enabling:
- Grafana dashboards for real-time visibility
- Alertmanager integration for on-call notifications
- Long-term trend analysis for quarterly reviews

### Implementation Summary

| Feature | Files Added/Modified | Key Benefit |
|---------|---------------------|-------------|
| RabbitMQ integration | `utils/rabbitmq.ts` | Async fanout, decoupled architecture |
| Rate limiting | `utils/rateLimiter.ts` | Spam prevention, fair usage |
| Audit logging | `utils/audit.ts`, `db/migrations/001_create_audit_logs.sql` | Security, compliance, recovery |
| Prometheus metrics | `utils/metrics.ts` | Observability, SLO monitoring |
| Structured logging | `utils/logger.ts` | Debugging, trace correlation |
| Enhanced health checks | `index.ts` | Kubernetes readiness, dependency monitoring |
| RBAC middleware | `middleware/auth.ts` | Fine-grained access control |
