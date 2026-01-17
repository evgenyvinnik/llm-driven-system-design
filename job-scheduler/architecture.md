# Job Scheduler - Architecture Design

## System Overview

A distributed task scheduling system that provides reliable job execution with cron-like scheduling, priority queues, and at-least-once execution guarantees.

## Requirements

### Functional Requirements

- **Job submission**: Create jobs with execution parameters, scheduling, and configuration
- **Scheduling**: One-time, recurring (cron), and delayed execution
- **Priority queues**: High-priority jobs execute before low-priority ones
- **Retry logic**: Automatic retries with exponential backoff
- **Job management**: Pause, resume, cancel, and trigger jobs
- **Monitoring**: Job status, execution history, worker status, metrics

### Non-Functional Requirements

- **Reliability**: At-least-once execution guarantee
- **Scalability**: Horizontal worker scaling
- **Latency**: Job pickup within 1 second of scheduled time
- **Availability**: Leader election for scheduler high availability
- **Consistency**: No duplicate execution through distributed locking

### Out of Scope

- Complex workflow orchestration (DAGs beyond simple scheduling)
- Multi-tenant isolation
- Specific execution environments (Docker, Lambda)

## Capacity Estimation

**Target Scale (for local development):**

- Jobs: 100-1000 concurrent jobs
- Workers: 3-5 instances
- Executions: 10,000+ per day

**Storage:**

- Job record: ~2KB (metadata, parameters, history)
- Execution record: ~1KB
- Execution log: ~500 bytes per entry

## High-Level Architecture

```
                              ┌─────────────────────────────────┐
                              │         Frontend Dashboard      │
                              │    (React + TanStack Router)    │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │           API Server            │
                              │     (Express + TypeScript)      │
                              └───────────────┬─────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │     Scheduler     │          │     PostgreSQL    │          │       Redis       │
    │   (Leader-Elected)│          │                   │          │                   │
    │                   │          │ - Job definitions │          │ - Priority queue  │
    │ - Scans due jobs  │          │ - Executions      │          │ - Leader locks    │
    │ - Enqueues work   │          │ - Execution logs  │          │ - Job locks       │
    └─────────┬─────────┘          └───────────────────┘          │ - Worker registry │
              │                                                   └─────────┬─────────┘
              └───────────────────────────────┬───────────────────────────────┘
                                              │
    ┌───────────────────────────────────────────────────────────────────────────────┐
    │                              Worker Pool                                       │
    │                                                                               │
    │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
    │   │ Worker 1 │   │ Worker 2 │   │ Worker 3 │   │ Worker 4 │   │ Worker N │   │
    │   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
    └───────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **API Server**
   - Handles job CRUD operations
   - Validates job definitions
   - Exposes metrics and monitoring endpoints
   - Serves frontend dashboard

2. **Scheduler Service**
   - Leader-elected component (only one active)
   - Scans for due jobs every second
   - Inserts jobs into priority queues
   - Recovers stalled executions
   - Schedules retries for failed jobs

3. **Priority Queue (Redis)**
   - Sorted set with priority as score
   - Visibility timeout for reliable processing
   - Dead letter queue for failed jobs

4. **Worker Pool**
   - Stateless job executors
   - Pull work from Redis queue
   - Execute handlers and report results
   - Support multiple concurrent jobs

5. **PostgreSQL**
   - Job definitions and metadata
   - Execution history and logs
   - Source of truth for job state

## Data Model

### Database Schema

```sql
-- Job definitions
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  handler VARCHAR(255) NOT NULL,
  payload JSONB DEFAULT '{}',
  schedule VARCHAR(100),           -- Cron expression
  next_run_time TIMESTAMP WITH TIME ZONE,
  priority INTEGER DEFAULT 50,
  max_retries INTEGER DEFAULT 3,
  initial_backoff_ms INTEGER DEFAULT 1000,
  max_backoff_ms INTEGER DEFAULT 3600000,
  timeout_ms INTEGER DEFAULT 300000,
  status job_status DEFAULT 'SCHEDULED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Job executions
CREATE TABLE job_executions (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  status execution_status NOT NULL,
  attempt INTEGER DEFAULT 1,
  scheduled_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  result JSONB,
  error TEXT,
  worker_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Execution logs
CREATE TABLE execution_logs (
  id UUID PRIMARY KEY,
  execution_id UUID REFERENCES job_executions(id),
  level VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Redis Data Structures

```
Priority Queue:
  job_scheduler:queue → Sorted Set (job_data, priority_score)

Processing:
  job_scheduler:processing → Sorted Set (execution_id:worker_id, timeout)

Dead Letter:
  job_scheduler:dead_letter → List (failed_execution_data)

Locks:
  job_scheduler:scheduler:leader → String (instance_id)
  job_scheduler:lock:{job_id} → String (execution_id)

Workers:
  job_scheduler:workers → Hash (worker_id → worker_info_json)
```

## API Design

### Core Endpoints

```
# Job Management
POST   /api/v1/jobs                    - Create job
GET    /api/v1/jobs                    - List jobs
GET    /api/v1/jobs/{id}               - Get job details
PUT    /api/v1/jobs/{id}               - Update job
DELETE /api/v1/jobs/{id}               - Delete job
POST   /api/v1/jobs/{id}/pause         - Pause job
POST   /api/v1/jobs/{id}/resume        - Resume job
POST   /api/v1/jobs/{id}/trigger       - Trigger immediate execution

# Executions
GET    /api/v1/jobs/{id}/executions    - List job executions
GET    /api/v1/executions/{id}         - Get execution details
POST   /api/v1/executions/{id}/cancel  - Cancel running execution
POST   /api/v1/executions/{id}/retry   - Retry failed execution

# Monitoring
GET    /api/v1/health                  - Health check
GET    /api/v1/metrics                 - System metrics
GET    /api/v1/workers                 - List workers
GET    /api/v1/dead-letter             - Dead letter queue
```

## Key Design Decisions

### Distributed Coordination

**Leader Election:**
- Uses Redis `SET NX EX` for simple, reliable leader election
- Lock TTL of 30 seconds with heartbeat every 10 seconds
- Standby schedulers attempt to acquire lock continuously

**Job Deduplication:**
- Distributed lock per job ID during execution
- Prevents duplicate execution when job recovered

### At-Least-Once Execution

**Visibility Timeout:**
- Jobs moved to processing set with timeout
- If not completed within timeout, recovered and re-enqueued
- Default timeout: 5 minutes

**Retry Logic:**
- Exponential backoff: `min(initial * 2^attempt, max)`
- Default: 1s initial, 1h max, 3 retries
- Failed jobs moved to dead letter queue

### Priority Scheduling

**Priority Queue:**
- Redis sorted set with inverted priority as score
- Higher priority jobs (100) get lower scores, processed first
- ZPOPMIN atomically removes highest priority job

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 18 + TypeScript | Modern, type-safe UI |
| **Routing** | TanStack Router | Type-safe routing |
| **State** | Zustand | Simple, lightweight state management |
| **Styling** | Tailwind CSS | Utility-first, rapid development |
| **Backend** | Node.js + Express | JavaScript ecosystem, async I/O |
| **Database** | PostgreSQL 15 | ACID, complex queries, reliability |
| **Queue** | Redis 7 | Fast, sorted sets for priority queue |
| **Logging** | Winston | Structured logging |

## Scalability Considerations

### Horizontal Scaling

- **API Servers**: Stateless, scale with load balancer
- **Schedulers**: Leader-elected, only one active
- **Workers**: Scale based on queue depth

### Database Scaling

- Read replicas for execution history queries
- Partition executions by month
- Archive old executions to cold storage

### Queue Scaling

- Redis Cluster for high throughput
- Separate queues per priority level if needed

## Trade-offs and Alternatives

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| Redis queues | Fast, memory-bound | Kafka (more durable) |
| Leader election | Simple, single scheduler | Distributed scheduling (complex) |
| Visibility timeout | At-least-once, possible duplicates | Distributed transactions (overhead) |
| PostgreSQL | ACID, scaling limits | Cassandra (better scale, less consistency) |

## Monitoring and Observability

### Key Metrics

- `jobs_enqueued_total`: Counter of jobs enqueued
- `jobs_completed_total`: Counter of completed jobs
- `jobs_failed_total`: Counter of failed jobs
- `job_queue_depth`: Current queue depth
- `job_execution_duration_seconds`: Execution time histogram
- `scheduler_lag_seconds`: Time behind schedule
- `workers_active`: Number of active workers

### Alerting

- Queue depth > 1000 for > 5 minutes
- Failure rate > 10% for > 5 minutes
- Scheduler lag > 60 seconds
- No active workers when queue > 0

## Caching Strategy

### Overview

The job scheduler uses a multi-layer caching approach optimized for read-heavy dashboard queries while maintaining strong consistency for job state mutations.

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Caching Layers                                  │
│                                                                         │
│   Browser Cache ──► API Response Cache ──► Redis Cache ──► PostgreSQL  │
│   (static assets)    (ETags, 304s)         (job metadata)   (source)   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern (Primary Strategy)

The system uses **cache-aside** for job metadata reads:

```typescript
// Read path: check cache first, fallback to database
async function getJob(jobId: string): Promise<Job> {
  const cacheKey = `job:${jobId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const job = await db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  await redis.setex(cacheKey, 300, JSON.stringify(job)); // TTL: 5 minutes
  return job;
}

// Write path: update database, then invalidate cache
async function updateJob(jobId: string, updates: Partial<Job>): Promise<void> {
  await db.query('UPDATE jobs SET ... WHERE id = $1', [jobId, ...]);
  await redis.del(`job:${jobId}`);
  await redis.del('jobs:list:*'); // Invalidate list caches
}
```

**Rationale**: Cache-aside is simpler to implement and reason about. Write-through adds complexity without significant benefit for this workload where writes are infrequent compared to dashboard reads.

### TTL Configuration

| Cache Key Pattern | TTL | Rationale |
|-------------------|-----|-----------|
| `job:{id}` | 5 minutes | Job metadata changes infrequently |
| `jobs:list:{page}:{filters}` | 30 seconds | List views need fresher data |
| `job:{id}:executions` | 10 seconds | Execution history updates frequently |
| `workers:status` | 5 seconds | Worker heartbeats are real-time |
| `metrics:summary` | 15 seconds | Dashboard metrics aggregate |
| `handlers:list` | 1 hour | Handler registry rarely changes |

### Cache Invalidation Rules

**Event-Driven Invalidation:**

| Event | Keys Invalidated |
|-------|------------------|
| Job created | `jobs:list:*` |
| Job updated | `job:{id}`, `jobs:list:*` |
| Job deleted | `job:{id}`, `jobs:list:*` |
| Execution started | `job:{id}:executions`, `metrics:*` |
| Execution completed | `job:{id}`, `job:{id}:executions`, `metrics:*` |
| Worker status change | `workers:status` |

**Pattern Deletion:**

```typescript
// Use Redis SCAN for pattern-based invalidation (not KEYS in production)
async function invalidatePattern(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    if (keys.length > 0) await redis.del(...keys);
    cursor = nextCursor;
  } while (cursor !== '0');
}
```

### Static Asset Caching

For the frontend dashboard (local development):

```typescript
// Express static file serving with cache headers
app.use('/assets', express.static('dist/assets', {
  maxAge: '1d',              // Cache JS/CSS for 1 day
  etag: true,
  lastModified: true,
}));

app.use('/', express.static('dist', {
  maxAge: '0',               // HTML files: no cache (always fresh)
  etag: true,
}));
```

### API Response Caching

```typescript
// ETag-based conditional requests for job lists
app.get('/api/v1/jobs', async (req, res) => {
  const jobs = await getJobsList(req.query);
  const etag = crypto.createHash('md5').update(JSON.stringify(jobs)).digest('hex');

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(jobs);
});
```

### CDN Considerations (Future Production)

For production deployment, static assets would be served via CDN:

- **Assets**: `/assets/*` with `Cache-Control: public, max-age=31536000, immutable`
- **API**: No CDN caching (private, authenticated)
- **Invalidation**: Version-based filenames (hash in filename) eliminate need for purging

## Authentication and Authorization

### Overview

The job scheduler implements session-based authentication with role-based access control (RBAC). This approach aligns with the project defaults (simple session auth, avoid OAuth/JWT complexity unless studying those topics).

### Authentication Flow

```
┌──────────┐        ┌──────────────┐        ┌─────────┐
│  Client  │───────►│  API Server  │───────►│  Redis  │
│          │◄───────│              │◄───────│(sessions)│
└──────────┘        └──────────────┘        └─────────┘
     │                     │
     │   POST /api/auth/login
     │   { username, password }
     │──────────────────────►
     │                     │
     │   Set-Cookie: session_id=abc123
     │◄──────────────────────
```

### Session Management

```typescript
// Session stored in Redis with 24-hour TTL
interface Session {
  userId: string;
  role: 'user' | 'admin';
  createdAt: number;
  lastActivity: number;
}

// Redis key: session:{session_id}
await redis.setex(`session:${sessionId}`, 86400, JSON.stringify(session));
```

**Session Configuration:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| Session TTL | 24 hours | Reasonable for dashboard use |
| Sliding expiration | Yes | Extends on activity |
| Cookie flags | `HttpOnly`, `SameSite=Strict` | Security best practices |
| Cookie secure | `true` in production | HTTPS only in prod |

### Role-Based Access Control (RBAC)

**Roles:**

| Role | Description |
|------|-------------|
| `user` | Can view jobs and executions, trigger own jobs |
| `admin` | Full access: create, update, delete jobs; manage workers; view all data |

**Permission Matrix:**

| Operation | Endpoint | `user` | `admin` |
|-----------|----------|--------|---------|
| List jobs | `GET /api/v1/jobs` | Own jobs only | All jobs |
| View job | `GET /api/v1/jobs/{id}` | Own jobs only | All jobs |
| Create job | `POST /api/v1/jobs` | No | Yes |
| Update job | `PUT /api/v1/jobs/{id}` | No | Yes |
| Delete job | `DELETE /api/v1/jobs/{id}` | No | Yes |
| Pause/Resume | `POST /api/v1/jobs/{id}/pause` | No | Yes |
| Trigger job | `POST /api/v1/jobs/{id}/trigger` | Own jobs only | All jobs |
| View executions | `GET /api/v1/executions` | Own jobs only | All jobs |
| Cancel execution | `POST /api/v1/executions/{id}/cancel` | No | Yes |
| Retry execution | `POST /api/v1/executions/{id}/retry` | Own jobs only | All jobs |
| View workers | `GET /api/v1/workers` | Read-only | Full access |
| Dead letter queue | `GET /api/v1/dead-letter` | Read-only | Full + requeue |
| System metrics | `GET /api/v1/metrics` | Limited | Full |

### Middleware Implementation

```typescript
// Authentication middleware
async function authenticate(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session_id;
  if (!sessionId) return res.status(401).json({ error: 'Authentication required' });

  const session = await redis.get(`session:${sessionId}`);
  if (!session) return res.status(401).json({ error: 'Session expired' });

  req.user = JSON.parse(session);
  // Extend session on activity
  await redis.expire(`session:${sessionId}`, 86400);
  next();
}

// Authorization middleware
function authorize(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Usage
app.post('/api/v1/jobs', authenticate, authorize('admin'), createJob);
app.get('/api/v1/jobs', authenticate, listJobs); // Role check inside handler
```

### Rate Limiting

**Configuration:**

| Endpoint Category | Limit | Window | Rationale |
|-------------------|-------|--------|-----------|
| Authentication (`/auth/*`) | 5 requests | 1 minute | Prevent brute force |
| Job creation (`POST /jobs`) | 10 requests | 1 minute | Prevent job flooding |
| Job trigger (`POST /jobs/*/trigger`) | 30 requests | 1 minute | Allow batch triggers |
| Read operations (`GET /*`) | 100 requests | 1 minute | Generous for dashboard |
| Admin operations | 50 requests | 1 minute | Reasonable admin use |

**Implementation:**

```typescript
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

const authLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:auth:' }),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, try again later' },
  keyGenerator: (req) => req.ip,
});

const jobCreationLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:jobs:' }),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Job creation rate limit exceeded' },
  keyGenerator: (req) => req.user?.userId || req.ip,
});

app.post('/api/auth/login', authLimiter, login);
app.post('/api/v1/jobs', authenticate, authorize('admin'), jobCreationLimiter, createJob);
```

### Local Development Defaults

For local development, authentication can be simplified:

```typescript
// Development mode: auto-login as admin
if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true') {
  app.use((req, res, next) => {
    req.user = { userId: 'dev-user', role: 'admin' };
    next();
  });
}
```

## Data Lifecycle Policies

### Overview

Data lifecycle management ensures storage costs remain reasonable, system performance stays consistent, and historical data remains accessible for auditing and replay.

### Data Categories

| Category | Table | Retention | Storage Tier |
|----------|-------|-----------|--------------|
| Job definitions | `jobs` | Indefinite | Hot (PostgreSQL) |
| Active executions | `job_executions` | 30 days | Hot (PostgreSQL) |
| Execution logs | `execution_logs` | 7 days | Hot (PostgreSQL) |
| Archived executions | `job_executions_archive` | 1 year | Cold (PostgreSQL/S3) |
| Dead letter queue | Redis list | 30 days | Hot (Redis) |
| Metrics data | Prometheus | 15 days | Hot (local) |

### Retention and TTL Policies

**PostgreSQL Partitioning (for executions):**

```sql
-- Partition job_executions by month
CREATE TABLE job_executions (
  id UUID NOT NULL,
  job_id UUID NOT NULL,
  status execution_status NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- ... other columns
) PARTITION BY RANGE (created_at);

-- Create monthly partitions (automated via cron or pg_partman)
CREATE TABLE job_executions_2024_01 PARTITION OF job_executions
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Archive old partitions
ALTER TABLE job_executions DETACH PARTITION job_executions_2023_12;
-- Export to S3/cold storage, then drop
```

**Automated Cleanup (Scheduler Job):**

```typescript
// Built-in maintenance job that runs daily
const maintenanceJob = {
  name: 'system:data-cleanup',
  handler: 'maintenance',
  schedule: '0 3 * * *', // 3 AM daily
  payload: {
    tasks: [
      { action: 'delete_old_executions', olderThanDays: 30 },
      { action: 'delete_old_logs', olderThanDays: 7 },
      { action: 'vacuum_tables', tables: ['job_executions', 'execution_logs'] },
    ],
  },
};
```

**Cleanup SQL:**

```sql
-- Delete executions older than 30 days (after archiving)
DELETE FROM job_executions
WHERE created_at < NOW() - INTERVAL '30 days'
  AND status IN ('COMPLETED', 'FAILED', 'CANCELLED');

-- Delete logs older than 7 days
DELETE FROM execution_logs
WHERE created_at < NOW() - INTERVAL '7 days';

-- Redis dead letter TTL (set on insertion)
LPUSH job_scheduler:dead_letter {execution_data}
EXPIRE job_scheduler:dead_letter 2592000  -- 30 days
```

### Archival to Cold Storage

**Archive Process:**

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  PostgreSQL     │─────►│  Archive Worker  │─────►│  MinIO (S3)     │
│  (hot data)     │      │  (daily job)     │      │  (cold storage) │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                 │
                                 ▼
                         ┌──────────────────┐
                         │  Archive Index   │
                         │  (PostgreSQL)    │
                         └──────────────────┘
```

**Archive Schema:**

```sql
-- Track archived data for retrieval
CREATE TABLE execution_archives (
  id UUID PRIMARY KEY,
  partition_name VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  record_count INTEGER NOT NULL,
  file_path VARCHAR(500) NOT NULL,  -- S3/MinIO path
  file_size_bytes BIGINT NOT NULL,
  checksum VARCHAR(64) NOT NULL,    -- SHA-256
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Example entry
INSERT INTO execution_archives VALUES (
  'a1b2c3d4...',
  'job_executions_2023_12',
  '2023-12-01',
  '2023-12-31',
  45000,
  's3://job-scheduler-archive/executions/2023/12/data.parquet',
  12582912,
  'sha256:abc123...',
  NOW()
);
```

**Archive Format:**

- **Format**: Parquet (columnar, compressed, schema-aware)
- **Compression**: Snappy (fast decompression for replay)
- **Partitioning**: One file per month per job type
- **Naming**: `{bucket}/executions/{year}/{month}/{job_type}.parquet`

### Backfill and Replay Procedures

**Replay from Archive:**

```typescript
// Restore archived executions for analysis or reprocessing
async function replayFromArchive(options: {
  startDate: Date;
  endDate: Date;
  jobType?: string;
  targetTable?: string; // Default: temp table
}): Promise<void> {
  // 1. Find relevant archive files
  const archives = await db.query(`
    SELECT file_path FROM execution_archives
    WHERE start_date >= $1 AND end_date <= $2
  `, [options.startDate, options.endDate]);

  // 2. Download from S3/MinIO
  for (const archive of archives) {
    const data = await minio.getObject('job-scheduler-archive', archive.file_path);

    // 3. Load into temporary table
    await loadParquetToPostgres(data, options.targetTable || 'temp_replay');
  }

  // 4. Re-enqueue jobs for replay if needed
  if (options.reprocess) {
    await db.query(`
      INSERT INTO job_executions (job_id, status, scheduled_at)
      SELECT job_id, 'PENDING', NOW()
      FROM temp_replay
      WHERE status = 'FAILED' AND job_type = $1
    `, [options.jobType]);
  }
}
```

**Backfill Scenarios:**

| Scenario | Procedure |
|----------|-----------|
| Missed jobs (scheduler downtime) | Query `jobs` for `next_run_time < NOW()`, enqueue with `immediate=true` |
| Failed job batch retry | Query dead letter queue, filter by error type, re-enqueue |
| Data migration | Export old format, transform, import to new schema |
| Disaster recovery | Restore PostgreSQL from backup, replay Redis queue from execution table |

**Backfill Job:**

```typescript
// Admin-triggered backfill for missed executions
app.post('/api/v1/admin/backfill', authenticate, authorize('admin'), async (req, res) => {
  const { startTime, endTime, jobIds, dryRun } = req.body;

  // Find jobs that should have run but didn't
  const missedJobs = await db.query(`
    SELECT j.id, j.schedule, j.handler, j.payload
    FROM jobs j
    WHERE j.status = 'SCHEDULED'
      AND j.id = ANY($1::uuid[])
      AND NOT EXISTS (
        SELECT 1 FROM job_executions e
        WHERE e.job_id = j.id
          AND e.scheduled_at BETWEEN $2 AND $3
      )
  `, [jobIds, startTime, endTime]);

  if (dryRun) {
    return res.json({ missedJobs, count: missedJobs.length });
  }

  // Enqueue missed jobs
  for (const job of missedJobs) {
    await enqueueJob(job, { backfill: true, originalScheduledTime: startTime });
  }

  res.json({ backfilled: missedJobs.length });
});
```

### Local Development Considerations

For local development, simplified lifecycle management:

```yaml
# docker-compose.yml - add cleanup volumes
services:
  postgres:
    volumes:
      - pgdata:/var/lib/postgresql/data
    # Reset with: docker-compose down -v

  redis:
    command: redis-server --maxmemory 100mb --maxmemory-policy allkeys-lru
    # Auto-eviction prevents unbounded growth

  minio:
    volumes:
      - miniodata:/data
    # Archives stored locally
```

```bash
# Development cleanup commands
npm run db:cleanup          # Delete data older than 7 days
npm run db:reset            # Drop and recreate all tables
npm run archive:export      # Export executions to local MinIO
npm run archive:import      # Import archived data for testing
```

## Security Considerations

- Input validation on all API endpoints
- Rate limiting on job creation
- No secrets in job payloads (use environment variables)
- Shell command handler disabled in production

## Future Optimizations

- Job dependencies (DAG workflows)
- Multi-tenancy with tenant isolation
- Job rate limiting per type/tenant
- Webhook notifications for job events
- Grafana dashboards
- Job timeout warnings
- Scheduled maintenance windows

## Implementation Notes

This section documents the WHY behind key implementation decisions, explaining the rationale for each pattern.

### Idempotency for Job Creation

**Why idempotency prevents duplicate job scheduling:**

Idempotency ensures that submitting the same job creation request multiple times produces the same result as a single submission. This is critical in distributed systems where:

1. **Network Reliability**: Clients may retry requests due to timeouts or network failures, even when the server successfully processed the original request. Without idempotency, each retry creates a duplicate job.

2. **User Experience**: Users may accidentally double-click submit buttons or refresh pages, triggering multiple submissions.

3. **System Integration**: External systems triggering jobs via API may have their own retry logic, leading to duplicate scheduling.

**Implementation approach:**

```typescript
// Two-layer idempotency protection:

// 1. Request-level: Idempotency-Key header for HTTP requests
// Caches response for duplicate requests within TTL window
app.post('/api/v1/jobs', idempotencyMiddleware(), ...)

// 2. Entity-level: Job name uniqueness check
const existingJob = await db.getJobByName(input.name);
if (existingJob) {
  return res.status(409).json({ error: 'Job already exists' });
}
```

**Trade-offs:**
- Redis storage overhead for idempotency keys (mitigated by TTL)
- Slightly higher latency for cache lookups
- Benefits: Prevents duplicate jobs, simplifies client error handling

### Role-Based Access Control (RBAC)

**Why RBAC separates job owners from administrators:**

RBAC provides security boundaries that protect system integrity while enabling appropriate access levels:

1. **Principle of Least Privilege**: Users should only have access to perform their required tasks. Job creators need to view status and trigger their jobs, but should not be able to modify system-wide settings or other users' jobs.

2. **Audit Trail**: RBAC enables clear accountability. When a job is paused or deleted, logs show which admin performed the action.

3. **Operational Safety**: Administrators can pause/resume/delete jobs, which are potentially destructive operations. Separating these permissions prevents accidental or unauthorized changes.

4. **Multi-Team Environments**: Different teams may share the scheduler. RBAC prevents one team from interfering with another's jobs.

**Permission matrix:**

| Operation | User Role | Admin Role |
|-----------|-----------|------------|
| View own jobs | Yes | Yes |
| Trigger own jobs | Yes | Yes |
| Create jobs | No | Yes |
| Update/Delete jobs | No | Yes |
| Pause/Resume jobs | No | Yes |
| View system metrics | Limited | Full |
| Manage users | No | Yes |

**Implementation:**

```typescript
// Middleware chain for protected routes
app.post('/api/v1/jobs',
  authenticate,           // Verify session
  authorize('admin'),     // Check role
  createJobHandler
);
```

### Job History Archival

**Why job history archival balances debugging vs storage:**

Execution history is valuable for debugging and auditing, but unbounded retention leads to:

1. **Storage Costs**: At 1KB per execution, 10,000 executions/day = 3.6GB/year in PostgreSQL alone, not counting indexes and logs.

2. **Query Performance**: Large tables slow down queries. Even with indexes, counting millions of rows or scanning for recent data degrades performance.

3. **Backup/Recovery Time**: Larger databases take longer to backup and restore, increasing RTO/RPO metrics.

**Retention strategy:**

| Data Type | Hot Storage | Cold Storage | Rationale |
|-----------|-------------|--------------|-----------|
| Job definitions | Indefinite | N/A | Always needed for scheduling |
| Active executions | 30 days | 1 year | Recent history for debugging |
| Execution logs | 7 days | N/A | Verbose, primarily for immediate debugging |
| Dead letter items | 30 days | N/A | Failed jobs need investigation window |

**Implementation:**

```typescript
// Scheduled maintenance job runs daily at 3 AM
const maintenanceJob = {
  name: 'system:data-cleanup',
  schedule: '0 3 * * *',
  handler: 'system.maintenance',
};

// Cleanup logic
async function runCleanup() {
  await deleteOldExecutions(30); // days
  await deleteOldLogs(7);        // days
}
```

**Trade-offs:**
- Data older than retention period is lost (unless archived to cold storage)
- Archival adds complexity but enables long-term analysis
- Benefits: Consistent performance, predictable storage costs

### Execution Metrics and SLA Monitoring

**Why execution metrics enable SLA monitoring:**

Prometheus metrics provide the observability needed to measure and maintain Service Level Agreements:

1. **SLA Definition**: Common SLAs include:
   - 99.9% of jobs start within 5 seconds of scheduled time
   - 95% of jobs complete within expected duration
   - Error rate below 1%

2. **Real-time Visibility**: Metrics enable dashboards showing current system health, not just post-mortem analysis.

3. **Alerting**: Prometheus integrates with Alertmanager to notify teams when SLA thresholds are breached.

4. **Capacity Planning**: Metrics like queue depth and execution duration inform scaling decisions.

**Key metrics implemented:**

```typescript
// Job lifecycle metrics
job_scheduler_jobs_scheduled_total     // Counter: jobs enqueued
job_scheduler_jobs_completed_total     // Counter: successful completions
job_scheduler_jobs_failed_total        // Counter: failures (with retry label)
job_scheduler_job_execution_duration_seconds  // Histogram: execution time

// Queue metrics
job_scheduler_queue_depth              // Gauge: pending jobs
job_scheduler_processing_count         // Gauge: in-flight jobs
job_scheduler_dead_letter_queue_size   // Gauge: failed jobs

// System health
job_scheduler_active_workers           // Gauge: worker count
job_scheduler_scheduler_is_leader      // Gauge: leader election status
job_scheduler_circuit_breaker_state    // Gauge: per-handler circuit state
```

**SLA alerting examples (Prometheus rules):**

```yaml
# Alert if queue depth exceeds threshold for 5 minutes
- alert: JobSchedulerQueueBacklog
  expr: job_scheduler_queue_depth > 1000
  for: 5m
  labels:
    severity: warning

# Alert if error rate exceeds 10%
- alert: JobSchedulerHighErrorRate
  expr: |
    rate(job_scheduler_jobs_failed_total[5m]) /
    rate(job_scheduler_jobs_completed_total[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
```

### Circuit Breaker for Job Execution

**Why circuit breakers prevent cascading failures:**

When a job handler depends on an external service (database, API, etc.) that becomes unavailable, naive retry behavior can:

1. **Exhaust Resources**: Workers continuously retry failing jobs, consuming CPU/memory while accomplishing nothing.

2. **Overload Recovering Services**: When the external service recovers, it may be overwhelmed by backed-up retry traffic.

3. **Mask Root Causes**: High failure rates in logs make it harder to identify the original failure.

**Circuit breaker states:**

```
CLOSED ──────► OPEN ──────► HALF-OPEN ──────► CLOSED
(healthy)      (failing)    (testing)          (recovered)
     ▲                           │
     └───────────────────────────┘
         (failures continue)
```

**Implementation:**

```typescript
const breaker = new CircuitBreaker(handler, {
  timeout: 60000,            // 60s before considering failed
  errorThresholdPercentage: 50,  // Trip at 50% failure rate
  resetTimeout: 30000,       // Wait 30s before testing
  volumeThreshold: 5,        // Need 5 requests to calculate percentage
});

// When circuit opens, jobs are requeued for later
if (error instanceof CircuitBreakerOpenError) {
  await queue.requeue(executionId, jobId, priority);
  return; // Don't count as failure
}
```

**Benefits:**
- Failing fast preserves worker capacity for healthy handlers
- Automatic recovery when external services return
- Visibility via metrics (`circuit_breaker_state`, `circuit_breaker_trips_total`)

### Structured JSON Logging with Pino

**Why structured logging improves observability:**

1. **Machine Parseable**: JSON logs can be ingested by log aggregation systems (ELK, Loki, Datadog) without custom parsing.

2. **Contextual Correlation**: Each log entry includes structured fields (jobId, executionId, workerId) enabling trace-like correlation:

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "job-scheduler",
  "instance": "worker-1",
  "jobId": "abc-123",
  "executionId": "def-456",
  "msg": "Job completed successfully",
  "duration": 1523
}
```

3. **Performance**: Pino is one of the fastest Node.js loggers, using lazy serialization and async I/O to minimize overhead.

4. **Development Experience**: In development, pino-pretty renders human-readable colored output while maintaining JSON structure in production.

**Log levels and usage:**

| Level | Usage |
|-------|-------|
| trace | Detailed debugging (disabled in production) |
| debug | Internal state, query execution |
| info | Normal operations, job completions |
| warn | Recoverable issues, retries scheduled |
| error | Failures, exceptions |
| fatal | Unrecoverable errors, process exit |
