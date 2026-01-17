# Design Reddit - Architecture

## System Overview

Reddit is a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. The core challenges involve efficient vote aggregation, nested comment handling, and content ranking algorithms.

**Learning Goals:**
- Implement voting systems that scale
- Design efficient nested comment storage and retrieval
- Build content ranking algorithms (hot, top, controversial)
- Handle community isolation (subreddits)

---

## Requirements

### Functional Requirements

1. **Subreddits**: Create communities, subscribe, set rules
2. **Posts**: Submit text/link/media posts to subreddits
3. **Comments**: Nested threaded discussions on posts
4. **Voting**: Upvote/downvote posts and comments
5. **Ranking**: Sort content by hot, new, top, controversial
6. **Moderation**: Remove content, ban users, automod

### Non-Functional Requirements

- **Availability**: 99.9% uptime
- **Latency**: < 100ms for feed loading
- **Scale**: Support millions of posts, billions of votes
- **Consistency**: Eventual consistency for vote counts (acceptable delay)

---

## Capacity Estimation (Learning Scale)

- **Users**: 100 active users locally
- **Subreddits**: 20 communities
- **Posts**: 1,000 posts
- **Comments**: 10,000 comments
- **Votes**: 100,000 votes

**Storage**: < 100 MB total

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│                    React + Tanstack Router                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                              │
│                    Node.js + Express                            │
│   - POST /subreddits, /posts, /comments                         │
│   - POST /vote                                                  │
│   - GET /r/:subreddit/hot, /new, /top                          │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Post Service │    │ Vote Service  │    │Comment Service│
│               │    │               │    │               │
│ - CRUD posts  │    │ - Cast votes  │    │ - Tree mgmt   │
│ - Ranking     │    │ - Aggregation │    │ - Threading   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────────┬───────────────────────────────────────────┤
│    PostgreSQL       │              Valkey                       │
│  - Users, posts     │  - Vote counts (cached)                   │
│  - Comments, votes  │  - Hot scores (precomputed)               │
│  - Subreddits       │  - Session storage                        │
└─────────────────────┴───────────────────────────────────────────┘
```

---

## Core Components

### 1. Voting System

**Challenge**: Counting votes efficiently without locking the database

**Approach 1: Direct Count (Simple)**
```sql
UPDATE posts SET score = score + 1 WHERE id = ?
```
- **Problem**: Row-level locks under high contention

**Approach 2: Write to Vote Table + Async Aggregation (Chosen)**
```sql
INSERT INTO votes (user_id, post_id, direction) VALUES (?, ?, 1)
-- Background job aggregates periodically
```
- **Pros**: No contention, can detect duplicates
- **Cons**: Slight delay in score updates (acceptable)

**Vote Storage:**
```sql
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  comment_id INTEGER REFERENCES comments(id),
  direction SMALLINT NOT NULL, -- 1 = up, -1 = down
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, post_id),
  UNIQUE(user_id, comment_id)
);

-- Aggregated scores cached in posts/comments tables
-- Background worker updates every 5-30 seconds
```

### 2. Nested Comments

**Challenge**: Efficiently storing and querying tree structures

**Approach 1: Adjacency List (Simple)**
```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES comments(id),
  post_id INTEGER REFERENCES posts(id),
  ...
);
```
- Requires recursive queries (slow for deep trees)

**Approach 2: Materialized Path (Chosen)**
```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id),
  path VARCHAR(255), -- e.g., "1.5.23.102"
  depth INTEGER,
  ...
);

-- Fetch all children of comment 5:
SELECT * FROM comments WHERE path LIKE '1.5.%' ORDER BY path;
```
- **Pros**: Single query for subtrees, easy sorting
- **Cons**: Path updates on moves (rare for comments)

**Approach 3: Nested Sets**
- Complex updates, better for read-heavy trees
- **Rejected**: Too complex for educational project

### 3. Ranking Algorithms

**Hot Algorithm:**
```javascript
// Reddit's hot algorithm (simplified)
function hotScore(ups, downs, createdAt) {
  const score = ups - downs
  const order = Math.log10(Math.max(Math.abs(score), 1))
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0
  const epochSeconds = 1134028003 // Reddit epoch
  const seconds = Math.floor(createdAt.getTime() / 1000) - epochSeconds
  return Math.round(sign * order + seconds / 45000, 7)
}
```

**Top Algorithm:**
```javascript
// Simple: highest score within time range
function topScore(ups, downs) {
  return ups - downs
}
```

**Controversial Algorithm:**
```javascript
// High total votes, close to 50/50 split
function controversialScore(ups, downs) {
  if (ups <= 0 || downs <= 0) return 0
  const magnitude = ups + downs
  const balance = Math.min(ups, downs) / Math.max(ups, downs)
  return magnitude * balance
}
```

**Precomputation Strategy:**
- Recalculate hot scores every 5 minutes for active posts
- Store in Valkey sorted sets for fast retrieval
- `ZREVRANGE r:programming:hot 0 24` → top 25 hot posts

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  karma_post INTEGER DEFAULT 0,
  karma_comment INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subreddits
CREATE TABLE subreddits (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(255),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  subscriber_count INTEGER DEFAULT 0,
  is_private BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE subscriptions (
  user_id INTEGER REFERENCES users(id),
  subreddit_id INTEGER REFERENCES subreddits(id),
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, subreddit_id)
);

-- Posts
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  subreddit_id INTEGER REFERENCES subreddits(id),
  author_id INTEGER REFERENCES users(id),
  title VARCHAR(300) NOT NULL,
  content TEXT,
  url VARCHAR(2048),
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  hot_score DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments (materialized path)
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id),
  author_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES comments(id),
  path VARCHAR(255) NOT NULL,
  depth INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX idx_comments_post ON comments(post_id);

-- Votes
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  comment_id INTEGER REFERENCES comments(id),
  direction SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_post_vote UNIQUE(user_id, post_id),
  CONSTRAINT unique_comment_vote UNIQUE(user_id, comment_id)
);
```

---

## API Design

```
# Subreddits
POST   /api/subreddits              - Create subreddit
GET    /api/subreddits/:name        - Get subreddit info
POST   /api/subreddits/:name/subscribe - Subscribe

# Posts
POST   /api/r/:subreddit/posts      - Create post
GET    /api/r/:subreddit/:sort      - List posts (hot/new/top)
GET    /api/posts/:id               - Get post with comments

# Comments
POST   /api/posts/:id/comments      - Create comment
GET    /api/posts/:id/comments      - Get comment tree

# Voting
POST   /api/vote                    - Cast vote
Body: { type: "post"|"comment", id: number, direction: 1|-1|0 }

# User
GET    /api/users/:username         - Get profile
GET    /api/users/:username/posts   - Get user's posts
```

---

## Key Design Decisions

### 1. Eventual Consistency for Vote Counts

**Decision**: Vote counts are eventually consistent (5-30 second delay)

**Rationale**:
- Avoids database contention
- Users rarely notice slight delays
- Enables horizontal scaling of vote service

**Alternative**: Real-time counts with Redis atomic increments
- Better UX but more complex
- Consider for Phase 2

### 2. Materialized Path for Comments

**Decision**: Use path strings like "1.5.23" for tree traversal

**Rationale**:
- Single query to fetch entire subtree
- Easy depth-based sorting
- No recursive CTEs needed

**Trade-off**: Path updates on comment moves (but moves are rare)

### 3. Precomputed Hot Scores

**Decision**: Background job recalculates hot scores every 5 minutes

**Rationale**:
- Hot algorithm is CPU-intensive
- Same scores used by many users
- Store in Valkey sorted set for O(log N) retrieval

---

## Scalability Considerations

### Database Sharding (Future)

- Shard by subreddit_id (each community independent)
- Cross-shard queries for user profiles (aggregate across shards)

### Caching Strategy

- **Valkey**: Hot post lists, vote counts, user sessions
- **CDN**: Static assets, embedded media
- **Application**: Parsed markdown cache

### Read Replicas

- Separate read/write for post listing (read-heavy)
- Eventual consistency acceptable for feeds

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Vote counting | Async aggregation | Real-time Redis | Avoid DB contention |
| Comment tree | Materialized path | Adjacency list | Faster subtree queries |
| Hot scores | Precomputed cache | On-demand calc | CPU efficiency |
| Database | PostgreSQL | Cassandra | Relational fits better |

---

## Local Multi-Instance Setup

```bash
# Terminal 1: API Server
npm run dev:server1  # Port 3001

# Terminal 2: Vote Aggregation Worker
npm run dev:worker

# Terminal 3: Hot Score Calculator
npm run dev:ranking

# Infrastructure
docker-compose up -d  # PostgreSQL, Valkey
```

---

## Observability

### Metrics (Prometheus + Grafana)

For local development, run Prometheus and Grafana via Docker Compose:

```yaml
# Add to docker-compose.yml
prometheus:
  image: prom/prometheus:v2.50.0
  ports:
    - "9090:9090"
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml

grafana:
  image: grafana/grafana:10.3.0
  ports:
    - "3000:3000"
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
```

**Key Metrics to Collect:**

| Metric | Type | Description | Alert Threshold |
|--------|------|-------------|-----------------|
| `http_request_duration_seconds` | Histogram | API latency by endpoint | p95 > 200ms |
| `http_requests_total` | Counter | Request count by status code | 5xx rate > 1% |
| `vote_aggregation_lag_seconds` | Gauge | Time since last vote aggregation | > 60s |
| `hot_score_calculation_duration` | Histogram | Ranking job performance | p95 > 30s |
| `db_connection_pool_size` | Gauge | PostgreSQL pool utilization | > 80% capacity |
| `valkey_memory_used_bytes` | Gauge | Cache memory usage | > 80% limit |
| `comment_tree_depth` | Histogram | Comment nesting depth | max > 20 |

**Express Middleware for Metrics:**
```javascript
// src/shared/metrics.ts
import { collectDefaultMetrics, Registry, Histogram, Counter } from 'prom-client'

export const register = new Registry()
collectDefaultMetrics({ register })

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register]
})

export const voteCounter = new Counter({
  name: 'votes_total',
  help: 'Total votes cast',
  labelNames: ['direction', 'target_type'],
  registers: [register]
})
```

### Logging (Structured JSON)

Use structured logging for easy parsing and filtering:

```javascript
// src/shared/logger.ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: process.env.SERVICE_NAME || 'reddit-api',
    version: process.env.npm_package_version
  }
})

// Usage examples:
logger.info({ userId: 123, postId: 456, direction: 1 }, 'vote cast')
logger.warn({ queueDepth: 1000, lag: 45 }, 'vote aggregation queue building up')
logger.error({ err, postId: 789 }, 'failed to calculate hot score')
```

**Log Levels by Environment:**
- `debug`: Local development (full request/response bodies)
- `info`: Staging (operations, user actions)
- `warn`: Production (degraded states, approaching limits)
- `error`: All environments (failures requiring attention)

### Distributed Tracing (OpenTelemetry)

For local development, use Jaeger for trace visualization:

```yaml
# Add to docker-compose.yml
jaeger:
  image: jaegertracing/all-in-one:1.54
  ports:
    - "16686:16686"  # UI
    - "4318:4318"    # OTLP HTTP
```

```javascript
// src/shared/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces'
  }),
  instrumentations: [
    new ExpressInstrumentation(),
    new PgInstrumentation(),
    new IORedisInstrumentation()
  ]
})

sdk.start()
```

**Key Spans to Trace:**
- `POST /vote` -> `insert_vote` -> `queue_aggregation`
- `GET /r/:subreddit/hot` -> `cache_lookup` -> `db_fallback` (if miss)
- `calculate_hot_scores` -> `fetch_posts` -> `update_cache`

### SLI Dashboard (Grafana)

Create a dashboard with these panels:

**Row 1: Request Performance**
- API latency (p50, p95, p99) over time
- Request rate by endpoint
- Error rate (5xx / total)

**Row 2: Vote System Health**
- Vote aggregation lag (target: < 30s)
- Votes per minute (trend line)
- Vote queue depth

**Row 3: Cache Performance**
- Valkey hit rate (target: > 90%)
- Cache memory usage
- Hot score freshness

**SLO Targets:**
| SLI | Target | Measurement |
|-----|--------|-------------|
| Feed load latency | p95 < 100ms | `http_request_duration_seconds{route="/r/:subreddit/:sort"}` |
| API availability | 99.9% | 1 - (5xx_count / total_count) |
| Vote visibility delay | < 30s | `vote_aggregation_lag_seconds` |
| Cache hit rate | > 85% | valkey hits / (hits + misses) |

### Audit Logging

Track security-relevant and moderation events:

```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id INTEGER REFERENCES users(id),
  actor_ip INET,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(20), -- 'post', 'comment', 'user', 'subreddit'
  target_id INTEGER,
  details JSONB,
  subreddit_id INTEGER REFERENCES subreddits(id)
);

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
```

**Events to Audit:**
| Action | Details |
|--------|---------|
| `user.login` | IP address, user agent |
| `user.login_failed` | IP address, attempted username |
| `post.delete` | Deleted by author vs moderator |
| `comment.delete` | Reason code, moderator ID |
| `user.ban` | Subreddit, duration, reason |
| `subreddit.settings_change` | Before/after values |
| `vote.suspicious` | Rapid voting pattern detected |

```javascript
// src/shared/audit.ts
import { pool } from './db'

interface AuditEvent {
  actorId: number | null
  actorIp: string
  action: string
  targetType?: 'post' | 'comment' | 'user' | 'subreddit'
  targetId?: number
  details?: Record<string, unknown>
  subredditId?: number
}

export async function audit(event: AuditEvent): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (actor_id, actor_ip, action, target_type, target_id, details, subreddit_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.actorId, event.actorIp, event.action, event.targetType,
     event.targetId, JSON.stringify(event.details), event.subredditId]
  )
}
```

---

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Hot Storage | Warm Storage | Cold/Archive | Total Retention |
|-----------|-------------|--------------|--------------|-----------------|
| Posts | 1 year | 2 years | Forever (S3) | Permanent |
| Comments | 1 year | 2 years | Forever (S3) | Permanent |
| Votes | 90 days | 1 year | Aggregate only | 1 year detail |
| Sessions | 30 days | N/A | N/A | 30 days |
| Audit logs | 90 days | 1 year | 7 years (S3) | 7 years |
| Hot scores | 24 hours | N/A | N/A | Recomputed |

### PostgreSQL Partitioning (for votes)

```sql
-- Partition votes by month for easy archival
CREATE TABLE votes (
  id SERIAL,
  user_id INTEGER NOT NULL,
  post_id INTEGER,
  comment_id INTEGER,
  direction SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE votes_2024_01 PARTITION OF votes
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE votes_2024_02 PARTITION OF votes
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Script to create future partitions (run monthly via cron)
-- See: src/db/scripts/create-vote-partition.sql
```

### Archival to Cold Storage (MinIO/S3)

```javascript
// src/workers/archiver.ts
import { pool } from '../shared/db'
import { minioClient } from '../shared/storage'
import { logger } from '../shared/logger'

async function archiveOldVotes(): Promise<void> {
  const cutoffDate = new Date()
  cutoffDate.setMonth(cutoffDate.getMonth() - 12) // 1 year ago

  const partitionName = `votes_${cutoffDate.getFullYear()}_${String(cutoffDate.getMonth() + 1).padStart(2, '0')}`

  // Export partition to JSON
  const result = await pool.query(
    `SELECT * FROM ${partitionName}`
  )

  const archiveData = JSON.stringify(result.rows)
  const archivePath = `archives/votes/${partitionName}.json.gz`

  // Upload to MinIO (gzip compressed)
  await minioClient.putObject('reddit-archive', archivePath,
    zlib.gzipSync(archiveData), {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip'
    })

  logger.info({ partition: partitionName, rows: result.rowCount }, 'archived vote partition')

  // Drop the old partition (only after confirming upload)
  await pool.query(`DROP TABLE IF EXISTS ${partitionName}`)
}
```

### Valkey TTL Configuration

```javascript
// src/shared/cache.ts
export const TTL = {
  HOT_SCORES: 5 * 60,      // 5 minutes - recomputed frequently
  USER_SESSION: 30 * 24 * 3600, // 30 days
  VOTE_COUNT: 60,          // 1 minute - eventually consistent
  SUBREDDIT_INFO: 3600,    // 1 hour - rarely changes
  USER_KARMA: 300          // 5 minutes - aggregated
}

// Apply TTL when setting cache values
await valkey.setex(`post:${postId}:score`, TTL.VOTE_COUNT, score)
await valkey.setex(`user:${userId}:session`, TTL.USER_SESSION, sessionData)
```

### Backfill and Replay Procedures

**Scenario 1: Rebuild hot scores after algorithm change**

```bash
# 1. Stop the ranking worker
docker-compose stop ranking-worker

# 2. Clear existing hot scores in Valkey
docker exec reddit-valkey valkey-cli KEYS "r:*:hot" | xargs docker exec -i reddit-valkey valkey-cli DEL

# 3. Run backfill script
npm run backfill:hot-scores

# 4. Restart ranking worker
docker-compose start ranking-worker
```

```javascript
// src/scripts/backfill-hot-scores.ts
import { pool } from '../shared/db'
import { valkey } from '../shared/cache'
import { calculateHotScore } from '../ranking/algorithms'

async function backfillHotScores(): Promise<void> {
  // Process in batches to avoid memory issues
  let offset = 0
  const batchSize = 1000

  while (true) {
    const posts = await pool.query(
      `SELECT id, subreddit_id, upvotes, downvotes, created_at
       FROM posts
       WHERE created_at > NOW() - INTERVAL '7 days'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [batchSize, offset]
    )

    if (posts.rows.length === 0) break

    for (const post of posts.rows) {
      const hotScore = calculateHotScore(post.upvotes, post.downvotes, post.created_at)
      await valkey.zadd(`r:${post.subreddit_id}:hot`, hotScore, post.id)
    }

    console.log(`Processed ${offset + posts.rows.length} posts`)
    offset += batchSize
  }
}

backfillHotScores().then(() => process.exit(0))
```

**Scenario 2: Replay votes after aggregation failure**

```bash
# 1. Identify the gap period from logs
# Example: aggregation worker was down from 14:00 to 14:30

# 2. Run targeted replay
npm run replay:votes -- --from "2024-01-15T14:00:00Z" --to "2024-01-15T14:30:00Z"
```

```javascript
// src/scripts/replay-votes.ts
async function replayVotes(from: Date, to: Date): Promise<void> {
  // Fetch all votes in the time range
  const votes = await pool.query(
    `SELECT post_id, comment_id, direction
     FROM votes
     WHERE created_at >= $1 AND created_at < $2`,
    [from, to]
  )

  // Aggregate by target
  const postScores = new Map<number, number>()
  const commentScores = new Map<number, number>()

  for (const vote of votes.rows) {
    if (vote.post_id) {
      postScores.set(vote.post_id, (postScores.get(vote.post_id) || 0) + vote.direction)
    }
    if (vote.comment_id) {
      commentScores.set(vote.comment_id, (commentScores.get(vote.comment_id) || 0) + vote.direction)
    }
  }

  // Apply aggregated scores (idempotent - overwrites current values)
  for (const [postId, scoreDelta] of postScores) {
    await pool.query(
      `UPDATE posts SET score = score + $1,
       upvotes = upvotes + CASE WHEN $1 > 0 THEN $1 ELSE 0 END,
       downvotes = downvotes + CASE WHEN $1 < 0 THEN -$1 ELSE 0 END
       WHERE id = $2`,
      [scoreDelta, postId]
    )
  }

  console.log(`Replayed ${votes.rowCount} votes`)
}
```

**Scenario 3: Restore from archive**

```bash
# Restore archived votes for analysis
npm run restore:votes -- --partition 2023_06
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development (Docker Compose):**

```bash
# Standard deployment - rebuild and restart all services
docker-compose down && docker-compose up -d --build

# Zero-downtime for API changes (run 2 instances)
docker-compose up -d --scale api=2 --no-recreate
# ... deploy new version ...
docker-compose up -d --build api
docker-compose up -d --scale api=1
```

**Staged Rollout Checklist:**

1. **Pre-deployment**
   - [ ] Run `npm run test` - all tests pass
   - [ ] Run `npm run lint` - no errors
   - [ ] Run `npm run db:migrate:dry-run` - review SQL changes
   - [ ] Check disk space on PostgreSQL volume

2. **Database migrations first** (see below)

3. **Deploy workers before API**
   - Vote aggregation worker
   - Ranking calculation worker
   - Archiver worker (if changed)

4. **Deploy API servers**
   - If multiple instances: rolling restart (one at a time)
   - Health check endpoint: `GET /health`

5. **Post-deployment**
   - [ ] Verify `/health` returns 200
   - [ ] Check Grafana dashboard for error spikes
   - [ ] Tail logs for unexpected errors: `docker-compose logs -f api`
   - [ ] Manually test critical paths (vote, post, comment)

### Schema Migrations

Use a migration runner with version tracking:

```sql
-- src/db/migrations/001_initial_schema.sql
-- Already applied, do not modify

-- src/db/migrations/002_add_hot_score_index.sql
CREATE INDEX CONCURRENTLY idx_posts_hot_score ON posts(subreddit_id, hot_score DESC);

-- src/db/migrations/003_add_audit_logs.sql
CREATE TABLE audit_logs (...);
```

**Migration Commands:**

```bash
# Preview migrations without applying
npm run db:migrate:dry-run

# Apply pending migrations
npm run db:migrate

# Check migration status
npm run db:migrate:status

# Rollback last migration (if rollback script exists)
npm run db:migrate:rollback
```

**Migration Script:**

```javascript
// src/db/migrate.ts
import { pool } from '../shared/db'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

async function migrate(dryRun = false): Promise<void> {
  // Create migrations table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Get applied migrations
  const applied = await pool.query('SELECT version FROM schema_migrations')
  const appliedVersions = new Set(applied.rows.map(r => r.version))

  // Find and sort migration files
  const migrationsDir = join(__dirname, 'migrations')
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const version = file.replace('.sql', '')
    if (appliedVersions.has(version)) continue

    const sql = readFileSync(join(migrationsDir, file), 'utf-8')

    if (dryRun) {
      console.log(`[DRY RUN] Would apply: ${file}`)
      console.log(sql)
      continue
    }

    console.log(`Applying: ${file}`)
    await pool.query(sql)
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
  }
}
```

**Safe Migration Practices:**

1. **Always use `CONCURRENTLY`** for index creation on large tables
2. **Add columns as nullable first**, then backfill, then add NOT NULL
3. **Never drop columns immediately** - mark deprecated, remove in next release
4. **Test migrations on a copy** of production data if possible

### Rollback Runbooks

**Rollback: Bad API Deployment**

```bash
# 1. Identify the bad commit
git log --oneline -5

# 2. Revert to previous working version
git checkout <previous-commit>

# 3. Rebuild and deploy
docker-compose up -d --build api

# 4. Verify rollback
curl http://localhost:3001/health
docker-compose logs -f api | head -50
```

**Rollback: Failed Database Migration**

```bash
# 1. Check which migration failed
npm run db:migrate:status

# 2. Connect to database and inspect
docker exec -it reddit-postgres psql -U reddit -d reddit

# 3. Manually revert if needed (example: drop new column)
ALTER TABLE posts DROP COLUMN IF EXISTS new_column;
DELETE FROM schema_migrations WHERE version = '004_add_new_column';

# 4. Fix migration file and retry
npm run db:migrate
```

**Rollback: Vote Aggregation Issues**

```bash
# Symptoms: Scores not updating, worker errors in logs

# 1. Check worker status
docker-compose logs vote-worker | tail -100

# 2. Check for stuck jobs
docker exec reddit-valkey valkey-cli LLEN vote-aggregation-queue

# 3. Restart worker
docker-compose restart vote-worker

# 4. If data is inconsistent, run full recalculation
npm run recalculate:scores -- --all
```

**Rollback: Cache Corruption**

```bash
# Symptoms: Stale data, inconsistent hot scores

# 1. Flush specific cache keys
docker exec reddit-valkey valkey-cli KEYS "r:*:hot" | xargs docker exec -i reddit-valkey valkey-cli DEL

# 2. Or flush entire cache (use cautiously)
docker exec reddit-valkey valkey-cli FLUSHDB

# 3. Trigger cache rebuild
npm run backfill:hot-scores
npm run backfill:vote-counts
```

**Emergency: Database Connection Exhaustion**

```bash
# Symptoms: "too many connections" errors

# 1. Check current connections
docker exec reddit-postgres psql -U reddit -c "SELECT count(*) FROM pg_stat_activity;"

# 2. Kill idle connections
docker exec reddit-postgres psql -U reddit -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE state = 'idle'
  AND query_start < NOW() - INTERVAL '10 minutes';
"

# 3. Restart API servers to reset connection pools
docker-compose restart api
```

---

## Implementation Notes

This section documents the rationale behind observability and operational features implemented in the backend.

### Why Metrics Enable Hot Post Detection and Spam Prevention

Prometheus metrics (`/metrics` endpoint) provide real-time visibility into system behavior that enables:

1. **Hot Post Detection (Rising Feed)**
   - `reddit_votes_total` counter tracks vote velocity by post type
   - Comparing vote rates over 5-minute windows identifies "rising" content
   - Posts receiving 10x normal vote velocity surface in rising feeds
   - Example: A post getting 50 votes/minute vs the subreddit average of 5 votes/minute

2. **Spam and Brigade Prevention**
   - `reddit_http_requests_total` by IP or user reveals coordinated activity
   - Vote velocity spikes without corresponding view increases suggest brigading
   - `reddit_karma_calculation_duration` spikes indicate suspicious batch voting
   - Rate limiting thresholds derived from p99 request patterns

3. **Performance Degradation Detection**
   - `reddit_http_request_duration_seconds` histogram shows latency percentiles
   - `reddit_db_query_duration_seconds` isolates slow database operations
   - `reddit_vote_aggregation_lag_seconds` alerts when scores become stale
   - Prevents user-visible issues by catching problems before complaints

**Implemented Metrics:**
- HTTP request duration and count by route
- Vote counts by direction and target type
- Karma calculation duration
- Hot score calculation duration and batch size
- Database connection pool utilization
- Cache hit/miss ratios

### Why Retention Policies Balance Community History vs Storage Costs

Data lifecycle management (`src/shared/retention.js`) implements tiered storage:

1. **Posts and Comments: Permanent Archival**
   - Community discussions are valuable historical context
   - Links in old posts may be referenced years later
   - Legal requirements for content moderation audits
   - Compress and move to cold storage (MinIO/S3) after 2 years
   - Cost: ~$0.004/GB/month in S3 Glacier vs $0.023/GB in PostgreSQL

2. **Votes: 90-Day Detail Retention**
   - Individual vote records only needed for fraud detection
   - After 90 days, only aggregate counts matter
   - Partitioned by month for easy archival
   - Reduces primary database size by 60-70%

3. **Audit Logs: 7-Year Retention**
   - Legal compliance (varies by jurisdiction)
   - Appeals process requires historical records
   - Hot storage for 90 days (frequent queries)
   - Warm storage for 1 year (occasional queries)
   - Cold archive for remaining 6 years

4. **Sessions: 30-Day Expiry**
   - No value in old session data
   - Redis TTL handles automatic cleanup
   - Reduces memory usage in cache layer

**Configuration via Environment:**
```bash
POST_HOT_STORAGE_DAYS=365      # Keep in PostgreSQL
POST_WARM_STORAGE_DAYS=730     # Keep before archival
VOTE_DETAIL_RETENTION_DAYS=90  # Keep individual votes
AUDIT_ARCHIVE_YEARS=7          # Total retention
```

### Why Audit Logging Enables Moderation Transparency

Audit logging (`src/shared/audit.js`) creates immutable records that:

1. **Support Moderation Appeals**
   - Users can request review of mod actions
   - Audit log shows: who acted, when, what was done, reason given
   - Prevents "he said, she said" disputes
   - Example: User claims post was wrongfully removed; log shows removal reason and moderator

2. **Detect Moderator Abuse**
   - Pattern analysis across audit logs reveals:
     - Mods targeting specific users
     - Unusual removal patterns (e.g., removing only opposing viewpoints)
     - Time correlation with personal disputes
   - Query: "Show all removals by mod X in subreddit Y this month"

3. **Legal Compliance**
   - Content moderation laws require audit trails
   - GDPR/CCPA data requests need action history
   - Law enforcement requests require verifiable records
   - IP addresses stored for abuse correlation

4. **Security Incident Investigation**
   - `user.login_failed` events detect brute force attempts
   - `vote.suspicious` events flag coordinated manipulation
   - IP-based queries identify compromised accounts

**Audited Events:**
- `user.login` / `user.login_failed` - Authentication attempts
- `post.delete` / `comment.delete` - Content removal
- `user.ban` / `user.unban` - User moderation
- `subreddit.settings_change` - Configuration changes
- `vote.suspicious` - Potential vote manipulation

### Why Graceful Shutdown Prevents Data Loss

Graceful shutdown handling (`src/index.js`) ensures:

1. **In-Flight Requests Complete**
   - Server stops accepting new connections immediately
   - Existing requests have 30 seconds to complete
   - Prevents 502/503 errors for users mid-request
   - Load balancer health check fails, directing traffic elsewhere

2. **Vote Aggregation Consistency**
   - Background workers finish current batch before exit
   - Prevents partial aggregation (some posts updated, others not)
   - `isShuttingDown` flag stops new batches from starting
   - Redis queue remains consistent

3. **Database Transaction Integrity**
   - Connection pool `end()` waits for active queries
   - No orphaned transactions holding locks
   - Prevents "connection reset" errors in logs
   - Clean reconnection on next startup

4. **Cache Persistence**
   - Redis `quit()` flushes pending writes
   - Session data persists across restarts
   - Vote caches remain consistent with database

**Shutdown Sequence:**
```
1. SIGTERM/SIGINT received
2. Set isShuttingDown = true (reject new requests)
3. server.close() - stop accepting connections
4. Wait for in-flight requests (max 30s)
5. pool.end() - close PostgreSQL connections
6. redis.quit() - close Redis connection
7. process.exit(0)
```

**Timeout Safety:**
- 30-second timeout prevents hung shutdowns
- Force exit after timeout (exit code 1)
- Kubernetes terminationGracePeriodSeconds should exceed this

---

## Future Optimizations

1. **Bloom filters** for vote deduplication
2. **Event sourcing** for vote history
3. **CQRS** for read-optimized feeds
4. **Elasticsearch** for subreddit search
5. **Kafka** for cross-service events
