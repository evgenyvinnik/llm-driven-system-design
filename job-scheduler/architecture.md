# Job Scheduler - Architecture Design

## System Overview

A distributed task scheduling system that provides reliable job execution with cron-like scheduling, priority queues, and at-least-once execution guarantees. The system separates concerns into three independently-scalable services: an API server for job management, a leader-elected scheduler for due-job detection, and a pool of stateless workers for execution. This project explores distributed coordination, leader election, visibility timeouts, and failure recovery in a job processing pipeline.

## Requirements

### Functional Requirements

- **Job Submission**: Create jobs with execution parameters, handler type, payload, and scheduling configuration
- **Scheduling**: One-time, recurring (cron expressions), and delayed execution
- **Priority Queues**: High-priority jobs execute before low-priority ones via Redis sorted sets
- **Retry Logic**: Automatic retries with exponential backoff and configurable max retries
- **Job Management**: Pause, resume, cancel, and trigger immediate execution
- **Monitoring**: Job status, execution history, worker status, queue depth, and dead letter queue inspection

### Non-Functional Requirements

- **Reliability**: At-least-once execution guarantee for every scheduled job
- **Scalability**: Horizontal worker scaling based on queue depth; 10,000+ executions per day
- **Latency**: Job pickup within 1 second of scheduled time
- **Availability**: Leader election ensures scheduler survives instance failures
- **Consistency**: Distributed locks prevent duplicate execution of the same job instance
- **Observability**: Full Prometheus metrics for scheduling lag, execution duration, error rates, and queue depth

### Out of Scope

- Complex workflow orchestration (DAG-based job dependencies)
- Multi-tenant isolation with per-tenant queues
- Container-based execution environments (Docker, Lambda)
- Sub-second scheduling precision

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Concurrent active jobs | 10,000-100,000 |
| Worker instances | 10-50 |
| Executions per day | 1,000,000+ |
| Queue throughput | 1,000 jobs/second peak |
| Job definition size | ~2 KB (metadata + payload) |
| Execution record size | ~1 KB |

### Storage Estimates

| Data | Volume | Retention |
|------|--------|-----------|
| Job definitions | ~200 MB (100K jobs) | Indefinite |
| Active executions (30 days) | ~30 GB | 30 days |
| Execution logs (7 days) | ~3.5 GB | 7 days |
| Archived executions | ~360 GB/year (Parquet) | 1 year |
| Redis queue state | ~100 MB | Ephemeral (TTL) |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent jobs | 100-1,000 |
| Worker instances | 1-3 |
| Executions per day | 10,000+ |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Clients / Dashboard                   │
└───────────────────────────┬─────────────────────────────┘
                            │
                   ┌────────▼────────┐
                   │   L7 Load       │
                   │   Balancer      │
                   └────────┬────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
   ┌────────▼────────┐ ┌───▼───────┐ ┌─────▼───────┐
   │   API Server 1  │ │ API Srv 2 │ │  API Srv N  │
   │   (Express)     │ │           │ │             │
   └────────┬────────┘ └─────┬─────┘ └──────┬──────┘
            │                │               │
            └────────────────┼───────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌───────▼───────┐ ┌─────────▼────────┐
│   PostgreSQL    │ │  Redis Cluster│ │   Scheduler      │
│                 │ │               │ │  (Leader-Elected) │
│ - Job defs      │ │ - Priority    │ │                   │
│ - Executions    │ │   queue       │ │ - Scans due jobs  │
│ - Logs          │ │ - Leader lock │ │ - Enqueues work   │
│ - Users         │ │ - Job locks   │ │ - Recovers stalls │
└─────────────────┘ │ - Worker      │ │ - Schedules       │
                    │   registry    │ │   retries         │
                    └───────┬───────┘ └─────────┬────────┘
                            │                   │
                            └─────────┬─────────┘
                                      │
   ┌──────────────────────────────────┼───────────────────────────────┐
   │                           Worker Pool                             │
   │                                                                   │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐         ┌──────────┐  │
   │  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  · · ·  │ Worker N │  │
   │  │ (5 slots)│  │ (5 slots)│  │ (5 slots)│         │ (5 slots)│  │
   │  └──────────┘  └──────────┘  └──────────┘         └──────────┘  │
   └──────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. API Server

Stateless Express service handling job CRUD operations, execution management, and monitoring endpoints. Validates job definitions, serves the frontend dashboard, and exposes Prometheus metrics.

### 2. Scheduler Service (Leader-Elected)

Only one scheduler instance is active at any time, ensured by Redis-based leader election. The scheduler runs a continuous loop:

1. **Acquire or renew leader lock** (`SET NX EX` with 30-second TTL, heartbeat every 10 seconds)
2. **Scan for due jobs**: Query PostgreSQL for jobs where `next_run_time <= NOW()` and `status = 'SCHEDULED'`
3. **Enqueue to priority queue**: Insert into Redis sorted set with inverted priority as score
4. **Recover stalled executions**: Check processing set for entries past visibility timeout
5. **Schedule retries**: Find failed executions eligible for retry, calculate next attempt with exponential backoff
6. **Compute next run time**: For recurring jobs, parse cron expression and update `next_run_time`

**Why leader election over distributed scheduling:** Multiple schedulers scanning the same jobs table would create duplicate enqueue operations. The leader lock eliminates this with minimal coordination overhead. Standby schedulers continuously attempt to acquire the lock, providing automatic failover within 30 seconds (lock TTL).

### 3. Priority Queue (Redis)

```
Queue:        job_scheduler:queue      → Sorted Set (score = -priority, member = job_data_json)
Processing:   job_scheduler:processing → Sorted Set (score = timeout_timestamp, member = execution_id:worker_id)
Dead Letter:  job_scheduler:dead_letter → List (failed execution data)
Leader Lock:  job_scheduler:scheduler:leader → String (instance_id, TTL 30s)
Job Lock:     job_scheduler:lock:{job_id} → String (execution_id, TTL = job timeout)
Workers:      job_scheduler:workers → Hash (worker_id → { status, active_jobs, last_heartbeat })
```

**Why Redis sorted sets for priority:** ZPOPMIN atomically removes and returns the lowest-score element, which maps to the highest priority job (using inverted scores). This is O(log N) insertion and O(1) pop -- compared to a PostgreSQL priority queue which requires SELECT...FOR UPDATE SKIP LOCKED, adding locking overhead and contention at high throughput.

### 4. Worker Pool

Stateless executors that pull work from the Redis queue. Each worker:

1. Calls `ZPOPMIN` to atomically claim the highest-priority job
2. Acquires a distributed lock for the job (`SET NX EX` with job timeout)
3. Moves the execution to the processing sorted set with a visibility timeout
4. Executes the registered handler function
5. On success: removes from processing set, updates execution status in PostgreSQL
6. On failure: increments attempt counter, schedules retry with exponential backoff, or moves to dead letter queue after max retries

**Concurrency:** Each worker processes up to `MAX_CONCURRENT_JOBS` (default 5) simultaneously using async handlers. Workers register heartbeats in Redis every 10 seconds to enable stale worker detection.

### 5. Handler System

Plugin-based architecture where job types map to handler functions registered at startup.

**Built-in handlers:**
- `http.request`: Make HTTP requests (webhooks, API calls)
- `shell.command`: Execute shell commands (disabled in production)
- `log.message`: Log a message (testing/debugging)
- `system.maintenance`: Data cleanup and archival tasks

**Why static registration over dynamic loading:** Handler functions run with full process privileges. Dynamic loading would require sandboxing and security auditing of uploaded code. Static registration is simpler and auditable.

## Database Schema

Defined in `backend/src/db/migrate.ts`.

```sql
-- Users table for RBAC authentication
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Job definitions and scheduling configuration
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    handler VARCHAR(255) NOT NULL,
    payload JSONB DEFAULT '{}',
    schedule VARCHAR(100),             -- Cron expression (NULL for one-time)
    next_run_time TIMESTAMP WITH TIME ZONE,
    priority INTEGER DEFAULT 50,       -- 1 (lowest) to 100 (highest)
    max_retries INTEGER DEFAULT 3,
    initial_backoff_ms INTEGER DEFAULT 1000,
    max_backoff_ms INTEGER DEFAULT 3600000,
    timeout_ms INTEGER DEFAULT 300000, -- 5 minutes
    status VARCHAR(50) DEFAULT 'SCHEDULED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Execution attempts with full lifecycle tracking
CREATE TABLE job_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'PENDING',
    attempt INTEGER DEFAULT 1,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    result JSONB,
    error TEXT,
    worker_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Structured execution logs from handler output
CREATE TABLE execution_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    execution_id UUID NOT NULL REFERENCES job_executions(id) ON DELETE CASCADE,
    level VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Index Strategy

| Index | Purpose |
|-------|---------|
| `jobs(status)` | Filter by job state (SCHEDULED, PAUSED, etc.) |
| `jobs(next_run_time)` | Scheduler scans for due jobs |
| `jobs(priority DESC)` | Priority ordering for dashboard |
| `jobs(name) UNIQUE` | Idempotent job creation |
| `job_executions(job_id)` | Execution history per job |
| `job_executions(status)` | Filter pending/running/failed |
| `job_executions(scheduled_at)` | Time-range queries |
| `job_executions(next_retry_at)` | Retry scheduling |
| `job_executions(created_at DESC)` | Recent executions first |
| `execution_logs(execution_id)` | Logs per execution |
| `update_updated_at_column()` trigger | Auto-update timestamps |

## API Design

### Job Management

```
POST   /api/v1/jobs                    → Create job
GET    /api/v1/jobs                    → List jobs (paginated, filterable)
GET    /api/v1/jobs/{id}               → Get job details
PUT    /api/v1/jobs/{id}               → Update job
DELETE /api/v1/jobs/{id}               → Delete job
POST   /api/v1/jobs/{id}/pause         → Pause job (stop scheduling)
POST   /api/v1/jobs/{id}/resume        → Resume paused job
POST   /api/v1/jobs/{id}/trigger       → Trigger immediate execution
```

### Execution Management

```
GET    /api/v1/jobs/{id}/executions    → List job executions
GET    /api/v1/executions/{id}         → Get execution details + logs
POST   /api/v1/executions/{id}/cancel  → Cancel running execution
POST   /api/v1/executions/{id}/retry   → Retry failed execution
```

### Monitoring

```
GET    /api/v1/health                  → Health check (PG, Redis)
GET    /api/v1/metrics                 → System metrics (JSON)
GET    /metrics                        → Prometheus metrics
GET    /api/v1/workers                 → List workers with status
GET    /api/v1/dead-letter             → Dead letter queue contents
```

## Key Design Decisions

### 1. At-Least-Once via Visibility Timeout

The core challenge of distributed job processing is ensuring every job runs at least once without requiring distributed transactions. We use a visibility timeout pattern inspired by AWS SQS:

1. Worker pops a job from the queue and moves it to the "processing" sorted set with a timeout score
2. The job becomes invisible to other workers for the duration of the timeout
3. If the worker completes the job, it removes the entry from the processing set
4. If the worker crashes or times out, the scheduler recovers the job by scanning the processing set for entries past their timeout

**The trade-off is possible duplicate execution.** If a job takes longer than its timeout, the scheduler re-enqueues it while the original worker is still processing. This is why "at-least-once" (not "exactly-once"): handlers must be idempotent or tolerate duplicate runs. For most job types (sending emails, processing files, making API calls), idempotency keys or deduplication at the destination handle this correctly.

**Why not distributed transactions?** Two-phase commit across Redis (queue) and PostgreSQL (state) would guarantee exactly-once but adds 10-100x latency per job, requires a transaction coordinator, and fails if either system is temporarily unavailable. The visibility timeout is simpler, faster, and tolerates partial failures.

### 2. Redis Leader Election over Distributed Scheduling

**Chosen: Single leader with Redis `SET NX EX`.**

With N schedulers independently scanning the jobs table, each would find the same due jobs and enqueue them N times. Deduplication at the queue level is complex because the scheduler must atomically check "is this job already enqueued?" and "enqueue if not" -- a read-then-write race condition.

The leader election pattern avoids this entirely: exactly one scheduler runs at any time. Standby instances continuously attempt to acquire the lock, providing automatic failover within the lock TTL (30 seconds). The leader sends heartbeats every 10 seconds to renew the lock, so failover only occurs after a genuine failure.

**The trade-off is a scheduling gap during failover.** When the leader dies, jobs due within the next 30 seconds may be delayed until the new leader acquires the lock. For most job scheduling use cases (cron-like tasks with minute-level precision), this delay is acceptable. Sub-second scheduling would require a different coordination approach (e.g., distributed consensus via Raft).

### 3. Redis Sorted Set over PostgreSQL for Queue

**Chosen: Redis sorted set with inverted priority scores.**

PostgreSQL can serve as a job queue using `SELECT ... FOR UPDATE SKIP LOCKED`, but this approach has contention issues at high throughput. With 50 workers all issuing `SELECT FOR UPDATE` simultaneously, PostgreSQL must lock and skip rows, creating lock contention and increased latency as queue depth grows.

Redis sorted sets offer O(log N) insertion and O(1) atomic pop via ZPOPMIN with no locking overhead. The trade-off is durability: Redis queue state lives in memory and can be lost on crash. We mitigate this by treating PostgreSQL as the source of truth -- the scheduler can always reconstruct the queue from the jobs table by scanning for due jobs.

## Consistency and Idempotency

### Job Creation Idempotency

Two-layer protection against duplicate job creation:

1. **Idempotency-Key header**: Redis-cached responses for duplicate HTTP requests (24-hour TTL). If a client retries a failed request, the same response is returned without creating a second job.
2. **Job name uniqueness**: `UNIQUE(name)` constraint in PostgreSQL. Even without an idempotency key, attempting to create a job with the same name returns a 409 Conflict.

### Execution Idempotency

Redis `SET NX EX` for execution-level locks keyed by `{job_id}:{scheduled_at}`. This prevents the scenario where the scheduler re-enqueues a job that a slow worker is still processing.

## Authentication and Authorization

### Session-Based Authentication

Session IDs stored in Redis with 24-hour TTL and sliding expiration. Cookies use `HttpOnly` and `SameSite=Strict` flags.

### Role-Based Access Control

| Operation | User Role | Admin Role |
|-----------|-----------|------------|
| View own jobs | Yes | Yes (all jobs) |
| Trigger own jobs | Yes | Yes (all jobs) |
| Create jobs | No | Yes |
| Update/Delete jobs | No | Yes |
| Pause/Resume jobs | No | Yes |
| View system metrics | Limited | Full |
| Manage workers/DLQ | No | Yes |

### Rate Limiting

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Authentication | 5 requests | 1 minute |
| Job creation | 10 requests | 1 minute |
| Job trigger | 30 requests | 1 minute |
| Read operations | 100 requests | 1 minute |

## Security

- **Input validation**: All API endpoints validate request bodies
- **No secrets in payloads**: Job payloads should reference environment variables, not contain secrets
- **Shell handler disabled in production**: The `shell.command` handler is restricted to development environments
- **Password hashing**: bcrypt for user password storage
- **Rate limiting**: Redis-backed rate limiting on authentication and job creation endpoints

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `job_scheduler_jobs_scheduled_total` | Counter | Jobs enqueued by handler/priority |
| `job_scheduler_jobs_executed_total` | Counter | Executions started by handler/worker |
| `job_scheduler_jobs_completed_total` | Counter | Successful completions |
| `job_scheduler_jobs_failed_total` | Counter | Failures by handler, with retry label |
| `job_scheduler_job_execution_duration_seconds` | Histogram | Execution time by handler/status |
| `job_scheduler_dead_letter_total` | Counter | Jobs moved to dead letter queue |
| `job_scheduler_queue_depth` | Gauge | Current pending jobs |
| `job_scheduler_processing_count` | Gauge | Currently in-flight jobs |
| `job_scheduler_dead_letter_queue_size` | Gauge | Failed jobs awaiting investigation |
| `job_scheduler_active_workers` | Gauge | Registered worker count |
| `job_scheduler_worker_active_jobs` | Gauge | Per-worker job count |
| `job_scheduler_scheduler_is_leader` | Gauge | Leader election status |
| `job_scheduler_stalled_jobs_recovered_total` | Counter | Stalled job recoveries |
| `job_scheduler_circuit_breaker_state` | Gauge | Per-handler circuit state |
| `job_scheduler_circuit_breaker_trips_total` | Counter | Circuit breaker trips |
| `job_scheduler_http_request_duration_seconds` | Histogram | API latency |
| `job_scheduler_http_requests_total` | Counter | API request count |

### Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| QueueBacklog | queue_depth > 1000 for 5 min | Warning |
| HighErrorRate | failed / completed > 10% for 5 min | Critical |
| SchedulerLag | No jobs picked up for 60 seconds | Critical |
| NoActiveWorkers | active_workers = 0 when queue > 0 | Critical |
| HighDLQSize | dead_letter_queue_size > 100 | Warning |

## Failure Handling

### Circuit Breaker for Job Handlers

Each handler type gets its own circuit breaker (Opossum) to isolate failures. If a handler's error rate exceeds 50% over 5 requests, the circuit opens and new jobs of that type are requeued for later rather than counted as failures. This prevents a single failing external service from consuming all worker capacity.

| Configuration | Value |
|---------------|-------|
| Timeout | 60 seconds |
| Error threshold | 50% failure rate |
| Reset timeout | 30 seconds |
| Volume threshold | 5 requests minimum |

### Failure Recovery Procedures

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Worker crashes mid-job | Visibility timeout expires; scheduler re-enqueues | Automatic (within timeout period) |
| Scheduler crashes | Standby acquires leader lock within 30s | Automatic (30s max gap) |
| Redis crashes | Queue state lost; API returns errors | Scheduler reconstructs queue from PostgreSQL jobs table |
| PostgreSQL crashes | No new jobs can be created; executions can't be recorded | Workers continue processing queued jobs; state updates buffered |
| Network partition (Redis-PG) | Split-brain risk for queue vs state | Leader lock prevents duplicate scheduling; idempotency prevents duplicate execution |

### Retry Strategy

Exponential backoff with configurable parameters:

```
delay = min(initial_backoff_ms * 2^attempt, max_backoff_ms)
```

| Attempt | Delay (default config) |
|---------|----------------------|
| 1st retry | 2 seconds |
| 2nd retry | 4 seconds |
| 3rd retry (max) | 8 seconds |
| After max retries | Move to dead letter queue |

## Caching Strategy

### Cache-Aside Pattern

The system uses cache-aside for job metadata reads from the dashboard:

| Cache Key Pattern | TTL | Rationale |
|-------------------|-----|-----------|
| `job:{id}` | 5 minutes | Job metadata changes infrequently |
| `jobs:list:{page}:{filters}` | 30 seconds | List views need fresher data |
| `job:{id}:executions` | 10 seconds | Execution history updates frequently |
| `workers:status` | 5 seconds | Worker heartbeats are real-time |
| `metrics:summary` | 15 seconds | Dashboard metrics aggregate |
| `handlers:list` | 1 hour | Handler registry rarely changes |

**Invalidation:** Event-driven invalidation on job create/update/delete and execution state changes. Uses Redis SCAN (not KEYS) for pattern-based invalidation.

## Scalability Considerations

### Horizontal Scaling

| Component | Strategy | Limit |
|-----------|----------|-------|
| API Servers | Stateless, add behind load balancer | Network/CPU |
| Scheduler | Single leader (cannot scale out) | PostgreSQL scan speed |
| Workers | Scale based on queue depth | Redis pop throughput |

### What Breaks First

At 10K jobs/second enqueue rate, the scheduler's PostgreSQL scan becomes the bottleneck (full table scan with `next_run_time <= NOW()`). Mitigation: partition the jobs table by status, index on `(status, next_run_time)`, or switch to an event-driven approach where job creation directly enqueues to Redis.

At 50+ workers, Redis ZPOPMIN contention may cause latency spikes. Mitigation: shard the queue by priority level or handler type across multiple sorted sets.

### Database Scaling

- **Read replicas**: Offload execution history queries to replicas
- **Partitioning**: Partition `job_executions` by month for efficient archival
- **Archival**: Move completed executions older than 30 days to cold storage (Parquet on S3/MinIO)

## Data Lifecycle

| Category | Hot (PostgreSQL) | Cold (S3/MinIO) | Delete |
|----------|-----------------|-----------------|--------|
| Job definitions | Indefinite | N/A | Manual |
| Active executions | 30 days | 1 year (Parquet) | After 1 year |
| Execution logs | 7 days | N/A | After 7 days |
| Dead letter queue | 30 days (Redis) | N/A | After 30 days |
| Prometheus metrics | 15 days | N/A | After 15 days |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Queue backend | Redis sorted set | PostgreSQL SKIP LOCKED | O(1) pop, no lock contention, 10x throughput |
| Coordination | Leader election (SET NX EX) | Distributed scheduling | Simple, no duplicate enqueue, 30s failover acceptable |
| Execution guarantee | At-least-once (visibility timeout) | Exactly-once (distributed transactions) | Simpler, faster; handlers must be idempotent |
| Job state | PostgreSQL | Redis only | ACID for job definitions; survives Redis restart |
| Handler architecture | Static registration | Dynamic loading | Simpler, auditable, no sandboxing needed |
| Session auth | Redis sessions + cookies | JWT | Immediate revocation, simpler |
| State management | Zustand | Redux | Less boilerplate, sufficient for dashboard |
| Routing | TanStack Router | React Router | Type-safe routing |

## Frontend Architecture

### Component Hierarchy

```
Layout (sidebar navigation + main content)
├── Dashboard (/)
│   ├── MetricCard (x8: total jobs, active jobs, queue depth, active workers,
│   │                    completed 24h, failed 24h, running now, dead letter queue)
│   └── JobTable (recent 5 jobs with pause/resume/trigger/delete actions)
├── Jobs (/jobs)
│   ├── Create Job button → CreateJobModal
│   ├── JobTable (full paginated list with actions)
│   └── Pagination (page navigation)
├── JobDetail (/jobs/$jobId)
│   ├── Job metadata (name, handler, schedule, priority, status)
│   ├── ExecutionList (paginated execution history for this job)
│   └── Action buttons (pause/resume/trigger/delete)
├── ExecutionDetail (/executions/$executionId)
│   ├── Execution metadata (status, attempt, worker, timing)
│   ├── Result/error display
│   └── Execution logs (structured log entries from handler)
└── Workers (/workers)
    ├── MetricCard (x4: active workers, total workers, total completed, total failed)
    └── Worker table (ID, status badge, active jobs, completed, failed, last heartbeat)
```

### Routing

TanStack Router with programmatic route definitions in `frontend/src/router.tsx`. The root route wraps all pages in a `Layout` component that provides a sidebar navigation with links. Five routes are registered:

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | DashboardPage | System overview with metrics and recent jobs |
| `/jobs` | JobsPage | Job CRUD with pagination and create modal |
| `/jobs/$jobId` | JobDetailPage | Single job detail with execution history |
| `/executions/$executionId` | ExecutionDetailPage | Single execution with structured logs |
| `/workers` | WorkersPage | Worker fleet monitoring |

The router uses dynamic route segments (`$jobId`, `$executionId`) for detail views, enabling type-safe parameter extraction via TanStack Router's hooks.

### Zustand Stores

Unlike the other projects that use a single store, this project splits state across three independent Zustand stores in `frontend/src/stores/index.ts`:

**`useJobsStore`** -- Job list and CRUD operations:

| State | Actions |
|-------|---------|
| `jobs`, `selectedJob`, `page`, `totalPages` | `fetchJobs(page)`, `fetchJob(id)`, `createJob(input)`, `updateJob(id, input)` |
| `loading`, `error` | `deleteJob(id)`, `pauseJob(id)`, `resumeJob(id)`, `triggerJob(id)` |

After every mutation (create, update, delete, pause, resume, trigger), the store automatically re-fetches the current page to reflect changes.

**`useMetricsStore`** -- Dashboard metrics and worker status:

| State | Actions |
|-------|---------|
| `metrics` (SystemMetrics) | `fetchMetrics()` |
| `workers` (Worker[]) | `fetchWorkers()` |

The Dashboard component polls both `fetchMetrics()` and `fetchWorkers()` every 5 seconds.

**`useExecutionsStore`** -- Execution history and detail:

| State | Actions |
|-------|---------|
| `executions`, `selectedExecution`, `page`, `totalPages` | `fetchExecutions(jobId?, page)`, `fetchExecution(id)` |
| `loading`, `error` | `cancelExecution(id)`, `retryExecution(id)` |

This three-store approach avoids unnecessary re-renders: updating a job does not trigger re-renders in components that only subscribe to metrics, and vice versa.

### Data Fetching

API functions are exported individually from `frontend/src/services/api.ts`. A generic `fetchApi<T>()` wrapper wraps all calls, handling JSON parsing and returning typed `ApiResponse<T>` objects. The API client covers job CRUD (create, read, update, delete, pause, resume, trigger), execution management (list, detail, cancel, retry), monitoring (system metrics, execution stats, workers, dead letter queue), and health checks.

### Key UI Patterns

- **Job lifecycle actions**: The JobTable component provides inline action buttons for each job -- Pause, Resume, Trigger, Delete -- with confirmation dialogs for destructive operations. Actions immediately re-fetch the job list to reflect state changes
- **Create job modal**: A modal overlay (`CreateJobModal`) for job creation with form fields for name, handler selection, cron expression, payload (JSON textarea), priority slider, and retry configuration
- **Worker heartbeat monitoring**: The Workers page calculates worker liveness by comparing `last_heartbeat` against a 60-second threshold. Workers with stale heartbeats are marked "offline" regardless of their reported status, providing accurate fleet visibility
- **Status badges**: Color-coded badges throughout the application: job status (SCHEDULED=blue, PAUSED=yellow, COMPLETED=green, FAILED=red), worker status (idle=green, busy=yellow, offline=gray), and execution status
- **Pagination**: The Pagination component in UI.tsx provides page navigation for jobs and executions, with the current page tracked in the Zustand store
- **Metric trends**: MetricCard components accept an optional `trend` prop ("up", "down", "neutral") to visually indicate whether a metric is improving or degrading
- **Auto-refresh**: The Dashboard and Workers pages poll the backend every 5 seconds using `setInterval` with cleanup in the `useEffect` return function

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project for readers unfamiliar with them.

### RBAC (Role-Based Access Control)

RBAC is a method of restricting system access based on roles assigned to users, rather than managing permissions for each user individually. Instead of maintaining a list like "Alice can create jobs, Bob can view jobs, Carol can trigger jobs," you define roles: "admins can create/update/delete/trigger jobs, users can view and trigger their own jobs." When Alice is promoted, you change her role from "user" to "admin" -- her permissions update automatically.

In this project, two roles exist: user (view own jobs, trigger own jobs, view limited metrics) and admin (full access to all jobs, workers, dead letter queue, and system metrics). The middleware extracts the user's role from their Redis-stored session, compares it against a permission matrix defined per endpoint, and returns 403 Forbidden if the role lacks the required permission. Session auth (rather than JWT) was chosen because sessions can be immediately revoked by deleting the Redis key -- with JWT, a revoked user could continue accessing the system until the token expires.

### Redis Cache-Aside

Cache-aside (lazy loading) is a caching pattern where the application checks the cache first and only queries the database on a cache miss. The key principle is that the application code manages both the cache and the database -- unlike "write-through" caching where the cache layer handles both reads and writes transparently.

In this project, job metadata is cached using cache-aside with multiple TTLs based on data volatility: `job:{id}` has a 5-minute TTL (job definitions change infrequently), `jobs:list:{page}:{filters}` has a 30-second TTL (list views need fresher data), and `workers:status` has a 5-second TTL (worker heartbeats are real-time). Cache invalidation is event-driven: when a job is created, updated, or deleted, the relevant cache keys are invalidated using Redis SCAN (not KEYS, which blocks the Redis server). The tradeoff is that briefly stale data may be served between a write and the next cache miss, which is acceptable for a dashboard but would not be for the scheduler's due-job scan (which always reads from PostgreSQL).

### Circuit Breaker

A circuit breaker detects repeated failures to a downstream service and stops calling it, preventing wasted resources and cascading failures. Named after the electrical device that trips to prevent a short circuit from causing a fire, the software circuit breaker has three states: Closed (normal -- requests pass through, failures are counted), Open (threshold exceeded -- requests immediately fail with a fallback, the downstream service gets breathing room to recover), and Half-Open (after a cooldown, a few test requests are sent to check recovery).

In this project, each job handler type gets its own circuit breaker using the Opossum library. This per-handler isolation is important: if the HTTP webhook handler fails because the target server is down, it should not prevent the log handler or shell command handler from executing. The circuit opens when the error rate exceeds 50% over 5 requests, and tests recovery after 30 seconds. When a handler's circuit is open, new jobs of that type are requeued for later processing rather than counted as failures -- this prevents burning through retry attempts while the downstream service is known to be unavailable. Prometheus metrics track each circuit's state transitions (`job_scheduler_circuit_breaker_state`, `job_scheduler_circuit_breaker_trips_total`).

### Structured Logging

Structured logging emits log entries as machine-parseable JSON objects rather than free-form text strings. A traditional log message like `"[2024-01-15 10:30:00] ERROR: Job report-gen failed on worker w-2 after 3 attempts: connection timeout"` is readable by humans but difficult to search programmatically. A structured entry like `{"level":"error","jobId":"report-gen","workerId":"w-2","attempt":3,"error":"connection timeout","event":"job_failed"}` enables precise queries: "show all failed jobs on worker w-2 in the last hour" without regex pattern matching.

This project uses Pino with contextual fields. Worker processes create child loggers with `workerId` baked in, so every log entry from that worker automatically includes its identifier. Similarly, when processing a job, the handler creates a child logger with `jobId` and `executionId`. In development, `pino-pretty` converts JSON to colored indented output for readability.

### Prometheus Metrics

Prometheus is a monitoring system that collects time-series data by scraping HTTP endpoints at regular intervals. The application exposes metrics at `GET /metrics` in a specific text format. Prometheus stores this data and enables queries, dashboards (via Grafana), and alerts.

This project exposes 17+ metrics covering every stage of the job lifecycle: scheduling (`job_scheduler_jobs_scheduled_total`), execution (`job_scheduler_jobs_executed_total`, `job_scheduler_job_execution_duration_seconds`), failures (`job_scheduler_jobs_failed_total`, `job_scheduler_dead_letter_total`), infrastructure (`job_scheduler_queue_depth`, `job_scheduler_active_workers`, `job_scheduler_scheduler_is_leader`), and per-handler circuit breaker state. The alerting rules section defines five alert conditions with thresholds -- for example, `QueueBacklog` fires if queue depth exceeds 1000 for 5 minutes, indicating workers cannot keep up with the scheduling rate.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window to prevent abuse and protect server resources. In a job scheduler, rate limiting prevents two failure modes: (1) a buggy client creating thousands of jobs in a tight loop, and (2) an attacker using the scheduler to amplify DDoS attacks via HTTP webhook jobs.

This project implements tiered rate limiting with Redis-backed counters: authentication endpoints allow 5 requests per minute (brute-force protection), job creation allows 10 per minute (prevents flooding), job triggering allows 30 per minute (more lenient for operations), and read operations allow 100 per minute. The rate limiting middleware runs before the route handler, checking a Redis counter keyed by user ID (or IP for unauthenticated requests) and returning HTTP 429 with a `Retry-After` header when the limit is exceeded.

### Idempotency

Idempotency ensures that performing the same operation multiple times has the same effect as performing it once. In a job scheduler, this prevents duplicate job creation from client retries and duplicate job execution from scheduler recovery.

Two levels of idempotency are implemented: (1) **Job creation**: An `Idempotency-Key` HTTP header is cached in Redis with a 24-hour TTL. If a client retries a `POST /api/v1/jobs` request with the same key, the cached response is returned without creating a duplicate job. Additionally, the `UNIQUE(name)` constraint on the jobs table prevents duplicate names at the database level. (2) **Execution-level dedup**: Redis `SET NX EX` on `{job_id}:{scheduled_at}` prevents the same job instance from being executed twice. This matters when the scheduler re-enqueues a job that timed out while a slow worker is still processing it -- the second worker's lock attempt fails, so it skips the job instead of double-executing it.

### Health Checks

Health checks are HTTP endpoints that report service status to infrastructure components. Load balancers use them to stop routing traffic to sick instances. Container orchestrators use them to restart crashed containers. Monitoring dashboards use them for at-a-glance system status.

This project exposes `GET /api/v1/health` which checks PostgreSQL connectivity (runs `SELECT 1`) and Redis connectivity (runs `PING`). The response includes the status of each dependency, enabling operators to quickly identify which component is failing. The health check is intentionally lightweight -- complex queries or heavy computations in a health check can cause false negatives under load (the service is healthy but the health check itself times out because the system is busy).

## Implementation Notes

This section maps the production architecture to what actually runs locally with Docker + Node.js + React.

### Local Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Local Machine                           │
│                                                               │
│  ┌──────────────┐   ┌───────────────────────────────────┐    │
│  │   Frontend   │   │          Backend Services          │    │
│  │   Vite :5173 │──▶│                                   │    │
│  │   React +    │   │  API Server      :3001             │    │
│  │   TanStack   │   │  Scheduler       (background)     │    │
│  │   Router +   │   │  Worker 1        (WORKER_ID=w-1)  │    │
│  │   Zustand    │   │  Worker 2        (WORKER_ID=w-2)  │    │
│  │              │   │  Worker 3        (WORKER_ID=w-3)  │    │
│  └──────────────┘   └────────┬──────────────┬───────────┘    │
│                              │              │                 │
│                      ┌───────▼──────┐ ┌─────▼─────┐          │
│                      │  PostgreSQL  │ │   Redis   │          │
│                      │    :5432     │ │   :6379   │          │
│                      │ job_scheduler│ │  (Valkey) │          │
│                      └──────────────┘ └───────────┘          │
│                                                               │
│                      docker-compose up -d                     │
└──────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File(s) | Description |
|---------|---------|-------------|
| Leader election | `src/queue/leader-election.ts` | Redis `SET NX EX` with 30s TTL and 10s heartbeat. Standby instances auto-acquire on leader failure. |
| Priority queue with visibility timeout | `src/queue/reliable-queue.ts` | Redis sorted sets for priority ordering and processing timeout tracking. ZPOPMIN for atomic dequeue. |
| Circuit breaker (Opossum) | `src/shared/circuit-breaker.ts` | Per-handler circuit breakers with configurable thresholds, Prometheus metrics per state, and automatic recovery. |
| Idempotency middleware | `src/shared/idempotency.ts` | Idempotency-Key header caching in Redis (24h TTL). Execution-level dedup via `SET NX EX` on `{job_id}:{scheduled_at}`. |
| Prometheus metrics (prom-client) | `src/shared/metrics.ts` | 17+ metrics covering jobs, queue, workers, scheduler, HTTP, and circuit breakers. Metrics middleware auto-instruments all endpoints. Exposed at `GET /metrics`. |
| Structured JSON logging (Pino) | `src/utils/logger.ts` | Pino with pino-pretty in dev. Contextual fields (jobId, executionId, workerId) on every log entry. |
| Session-based RBAC | `src/shared/auth.ts` | Session auth with Redis storage. User/admin roles with permission matrix. Rate limiting on auth endpoints. |
| Dead letter queue | `src/queue/reliable-queue.ts` | Failed jobs after max retries moved to Redis list for manual inspection and requeue. |
| Exponential backoff retries | `src/worker/index.ts` | `min(initial * 2^attempt, max)` with configurable initial/max/retries per job. |
| Data archival module | `src/shared/archival.ts` | Archival logic for moving old executions to cold storage. |
| Multi-service architecture | `package.json` scripts | Separate `dev:api`, `dev:scheduler`, `dev:worker1-3` scripts for running each service independently. |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|-----------------|--------|
| L7 Load Balancer + multiple API instances | Single API server (:3001) | No request distribution or failover |
| Redis Cluster (sharded) | Single Valkey instance (:6379) | No sharding; queue is single point of failure |
| PostgreSQL with read replicas | Single PostgreSQL (:5432) | No read scaling for execution history |
| S3/MinIO cold storage | Archival module exists but no MinIO in docker-compose | No actual cold storage pipeline |
| Prometheus + Grafana | Metrics endpoint only | Metrics exposed but no scraping or dashboards |
| Multiple scheduler standby instances | Single scheduler process | No failover testing (but leader election code is functional) |
| Container orchestration (K8s) | Manual process management via npm scripts | No auto-scaling, no health-based routing |
| OAuth/JWT for external API access | Session-based auth only | Simpler but not suitable for service-to-service auth |
| PostgreSQL partitioning (monthly) | Single unpartitioned tables | No partition pruning or easy archival |
| Grafana alerting | Alert thresholds in code only | No active alerting infrastructure |

### What Was Omitted

- **Job dependencies (DAG workflows)**: Would require a dependency graph resolver and topological sorting for execution order. Deferred to avoid scope creep.
- **Multi-tenancy**: Per-tenant job isolation, separate queues, and tenant-scoped rate limiting. Would require tenant_id on all tables and Redis key namespacing.
- **Webhook notifications**: Callback on job completion/failure to external systems. Would use RabbitMQ for reliable delivery.
- **Container-based execution**: Running job handlers in isolated Docker containers or Lambda functions for security and resource isolation.
- **Kubernetes deployment**: HPA for auto-scaling workers based on queue depth, StatefulSet for scheduler, and Deployment for API servers.
- **Grafana dashboards**: Visual monitoring of the comprehensive Prometheus metrics already being collected.
- **Job rate limiting per type**: Preventing job flooding by limiting enqueue rate per handler type or user.
- **Distributed tracing**: OpenTelemetry integration for tracing a job from creation through scheduling to execution.
