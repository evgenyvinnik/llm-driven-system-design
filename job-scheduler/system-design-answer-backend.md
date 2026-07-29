# Job Scheduler - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"Today I'll design a distributed job scheduler, focusing on the backend systems that ensure reliable, at-least-once execution. The key challenges are distributed coordination through leader election, priority queue management with visibility timeouts, retry logic with exponential backoff, and circuit breakers to prevent cascading failures."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Job submission** - Submit jobs with execution parameters, scheduling, and dependencies
2. **Scheduling** - One-time, recurring (cron), and delayed execution
3. **Priority queues** - High-priority jobs execute before low-priority ones
4. **Retry logic** - Automatic retries with exponential backoff
5. **Job dependencies** - Job B runs only after Job A completes
6. **Monitoring** - Job status, execution history, metrics
7. **Job management** - Pause, cancel, modify jobs

### Non-Functional Requirements

- **Reliability**: At-least-once execution guarantee
- **Scalability**: Handle 1M+ jobs/day, 10K concurrent executions
- **Latency**: Job pickup within 1 second of scheduled time
- **Availability**: 99.99% uptime
- **Consistency**: No duplicate execution (exactly-once preferred)

### Backend Deep Dive Areas

- Leader election for scheduler high availability
- Priority queue with visibility timeout
- Distributed locking for deduplication
- Circuit breaker pattern for handler failures

---

## Step 2: Database Schema Design

### PostgreSQL Schema

Postgres is the source of truth for definitions and history. Four tables:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| `jobs` | id (UUID PK), name (unique), handler, payload (JSONB), schedule (cron), next_run_time, priority (0–100), max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, owner_id | partial index on `next_run_time WHERE status='SCHEDULED'`; index on status | The partial index is the one that matters — the scheduler scans "due and schedulable" every tick, and it keeps that scan off the paused and completed rows entirely |
| `job_executions` | id (UUID PK), job_id (FK), status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result (JSONB), error, worker_id | (job_id); (status); partial on `next_retry_at WHERE status='PENDING_RETRY'` | Range-partitioned monthly by `created_at`. One row *per attempt*, never mutated in place — attempt 2 is a new row, so the full failure history survives |
| `execution_logs` | id (UUID PK), execution_id (FK), level, message, metadata (JSONB) | (execution_id) | Highest-volume table; follows the execution partition's lifecycle |
| `execution_archives` | id, partition_name, start_date, end_date, record_count, file_path, file_size_bytes, checksum | (partition_name) | Bookkeeping for detached partitions shipped to object storage |

> "The design choice I'd defend hardest here is one row per attempt rather than a retry counter on a single row. A counter tells you a job failed four times; separate rows tell you *how* each attempt failed, on which worker, and how long it ran before dying. When someone asks at 3am why a job has been flapping for a week, that history is the entire investigation. The cost is table growth proportional to retries, which is exactly why executions are partitioned and archived."

### Redis Data Structures

Redis holds everything coordination-related — all of it reconstructible, none of it the source of truth:

| Key | Type | Contents | Expiry |
|-----|------|----------|--------|
| `job_scheduler:queue` | Sorted set | Pending executions, scored by inverted priority so `ZPOPMIN` returns the most important first | — |
| `job_scheduler:processing` | Sorted set | In-flight executions scored by their visibility deadline | — (swept by the recovery loop) |
| `job_scheduler:dead_letter` | List | Executions that exhausted their retry budget, with error and failure time | 30 days |
| `job_scheduler:scheduler:leader` | String | Instance ID of the current scheduler leader | 30s, refreshed on heartbeat |
| `job_scheduler:lock:{job_id}` | String | Execution ID currently holding the job — the dedup guard | 1 hour |
| `job_scheduler:workers` | Hash | worker_id → start time, concurrency, status, last heartbeat | — (staleness judged by heartbeat age) |
| `idempotency:{key}` | String | Cached response for a repeated mutating request | 1 hour |

---

## Step 3: Leader Election for Scheduler

### The Challenge

Only one scheduler should be active to prevent duplicate job enqueueing, but we need automatic failover if the leader dies.

### Redis-Based Leader Election

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Scheduler Leader Election                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Configuration:                                                      │
│  ├── instanceId: crypto.randomUUID()                                │
│  ├── leaderKey: 'job_scheduler:scheduler:leader'                    │
│  ├── lockTTL: 30 seconds                                            │
│  └── heartbeatInterval: 10 seconds                                  │
│                                                                      │
│  Startup:                                                            │
│    tryAcquireLeadership() ──▶ SET leaderKey instanceId NX EX 30     │
│        │                                                             │
│        ├── result === 'OK' ──▶ isLeader = true, log "Acquired"      │
│        └── result === null ──▶ isLeader = false                     │
│                                                                      │
│  Heartbeat (every 10s):                                              │
│    │                                                                 │
│    ├── if isLeader:                                                 │
│    │     SET leaderKey instanceId XX EX 30                          │
│    │       │                                                         │
│    │       ├── result !== 'OK' ──▶ isLeader = false (lost leader)   │
│    │       └── result === 'OK' ──▶ continue as leader               │
│    │                                                                 │
│    └── if !isLeader:                                                │
│          tryAcquireLeadership() (leader may have failed)            │
│                                                                      │
│  Scheduler Loop (100ms interval):                                    │
│    │                                                                 │
│    ├── if !isLeader ──▶ sleep(1000), continue                       │
│    │                                                                 │
│    └── if isLeader:                                                 │
│          ├── scanAndEnqueueDueJobs()                                │
│          ├── recoverStalledExecutions()                             │
│          └── scheduleRetries()                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Scanning for Due Jobs

```
┌─────────────────────────────────────────────────────────────────────┐
│                    scanAndEnqueueDueJobs()                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Query due jobs with locking:                                        │
│    SELECT * FROM jobs                                                │
│    WHERE status = 'SCHEDULED'                                        │
│      AND next_run_time <= NOW()                                      │
│      AND next_run_time > NOW() - INTERVAL '5 minutes'               │
│    ORDER BY next_run_time                                            │
│    LIMIT 1000                                                        │
│    FOR UPDATE SKIP LOCKED                                            │
│                                                                      │
│  For each due job:                                                   │
│    │                                                                 │
│    ├── [1] Create execution record                                  │
│    │       INSERT INTO job_executions                               │
│    │       (id, job_id, status='PENDING', scheduled_at, attempt=1)  │
│    │                                                                 │
│    ├── [2] Enqueue to Redis with inverted priority                  │
│    │       ZADD job_scheduler:queue (100 - priority) {              │
│    │         executionId, jobId, handler, payload, timeout          │
│    │       }                                                         │
│    │                                                                 │
│    └── [3] Update job for next run                                  │
│            │                                                         │
│            ├── if has cron schedule:                                │
│            │     Calculate next_run_time from cron                  │
│            │     UPDATE jobs SET status='SCHEDULED', next_run_time  │
│            │                                                         │
│            └── if one-time:                                         │
│                  UPDATE jobs SET status='QUEUED'                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 4: Priority Queue with Visibility Timeout

### Queue Design for At-Least-Once Execution

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ReliableQueue Operations                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  enqueue(executionData, priority):                                   │
│    ZADD job_scheduler:queue (100 - priority) JSON(executionData)    │
│    metrics.jobsEnqueued.inc({handler})                              │
│                                                                      │
│  dequeue(workerId):                                                  │
│    │                                                                 │
│    ├── [1] ZPOPMIN job_scheduler:queue ──▶ (data, score)            │
│    │       if empty ──▶ return null                                 │
│    │                                                                 │
│    ├── [2] Calculate visibility timeout                             │
│    │       timeout = Date.now() + (executionData.timeout || 300000) │
│    │                                                                 │
│    └── [3] ZADD job_scheduler:processing timeout                    │
│            "{executionId}:{workerId}:{data}"                        │
│                                                                      │
│  complete(executionId, workerId):                                    │
│    Scan processing set for pattern "{executionId}:{workerId}:*"     │
│    ZREM job_scheduler:processing member                             │
│    metrics.jobsCompleted.inc()                                      │
│                                                                      │
│  recoverStalled():                                                   │
│    │                                                                 │
│    ├── ZRANGEBYSCORE job_scheduler:processing -inf {now}            │
│    │                                                                 │
│    └── For each stalled item:                                       │
│          Parse: {executionId}:{workerId}:{data}                     │
│          ZADD job_scheduler:queue 0 {data}  (highest priority)      │
│          ZREM job_scheduler:processing item                         │
│          log warning "Recovered stalled execution"                  │
│                                                                      │
│  moveToDeadLetter(executionData, error):                             │
│    LPUSH job_scheduler:dead_letter JSON({...data, error, failedAt}) │
│    EXPIRE job_scheduler:dead_letter 30d                             │
│    metrics.deadLetterSize.inc()                                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Deduplication with Distributed Locks

```
┌─────────────────────────────────────────────────────────────────────┐
│                    executeWithDeduplication()                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  lockKey = "job_scheduler:lock:{jobId}"                             │
│                                                                      │
│  Try acquire lock:                                                   │
│    SET lockKey executionId NX EX 3600                               │
│        │                                                             │
│        ├── acquired ──▶ proceed to execute job                      │
│        │                                                             │
│        └── not acquired:                                            │
│              holder = GET lockKey                                   │
│                │                                                     │
│                ├── holder === executionId ──▶ proceed (our lock)    │
│                │                                                     │
│                └── holder !== executionId:                          │
│                      UPDATE job_executions                          │
│                      SET status = 'DEDUPLICATED',                   │
│                          completed_at = NOW()                       │
│                      WHERE id = executionId                         │
│                                                                      │
│                      log "Deduplicated execution"                   │
│                      return (skip execution)                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Retry Logic with Exponential Backoff

### Failure Handling

```
┌─────────────────────────────────────────────────────────────────────┐
│                    handleFailure(executionId, error)                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Load execution with job config:                                     │
│    SELECT e.*, j.max_retries, j.initial_backoff_ms,                 │
│           j.max_backoff_ms, j.handler, j.payload, j.priority        │
│    FROM job_executions e                                             │
│    JOIN jobs j ON e.job_id = j.id                                   │
│    WHERE e.id = executionId                                          │
│                                                                      │
│  Decision:                                                           │
│    │                                                                 │
│    ├── attempt < max_retries:                                       │
│    │     │                                                           │
│    │     ├── Calculate backoff:                                     │
│    │     │   baseBackoff = initial_backoff_ms * 2^attempt           │
│    │     │   cappedBackoff = min(baseBackoff, max_backoff_ms)       │
│    │     │   jitter = random() * 0.3 * cappedBackoff                │
│    │     │   backoffMs = cappedBackoff + jitter                     │
│    │     │                                                           │
│    │     ├── nextRetryAt = now + backoffMs                          │
│    │     │                                                           │
│    │     └── UPDATE job_executions                                  │
│    │         SET status = 'PENDING_RETRY',                          │
│    │             next_retry_at = nextRetryAt,                       │
│    │             error = error.message,                             │
│    │             attempt = attempt + 1                              │
│    │                                                                 │
│    │     log "Scheduled retry" {attempt, maxRetries, nextRetryAt}   │
│    │     metrics.jobsRetried.inc({handler})                         │
│    │                                                                 │
│    └── attempt >= max_retries:                                      │
│          │                                                           │
│          ├── UPDATE job_executions                                  │
│          │   SET status = 'FAILED',                                 │
│          │       error = error.message,                             │
│          │       completed_at = NOW()                               │
│          │                                                           │
│          ├── queue.moveToDeadLetter({...}, error.message)           │
│          │                                                           │
│          ├── alerting.notify('job_failed', {...})                   │
│          │                                                           │
│          └── metrics.jobsFailed.inc({handler})                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Scheduler Retry Processing

```
┌─────────────────────────────────────────────────────────────────────┐
│                    scheduleRetries()                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Query pending retries:                                              │
│    SELECT e.*, j.handler, j.payload, j.priority                     │
│    FROM job_executions e                                             │
│    JOIN jobs j ON e.job_id = j.id                                   │
│    WHERE e.status = 'PENDING_RETRY'                                  │
│      AND e.next_retry_at <= NOW()                                    │
│    LIMIT 500                                                         │
│    FOR UPDATE SKIP LOCKED                                            │
│                                                                      │
│  For each execution:                                                 │
│    │                                                                 │
│    ├── UPDATE job_executions                                        │
│    │   SET status = 'PENDING', next_retry_at = NULL                 │
│    │                                                                 │
│    └── queue.enqueue({                                              │
│          executionId, jobId, handler,                               │
│          payload, timeout, attempt                                  │
│        }, priority)                                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Circuit Breaker Pattern

### Preventing Cascading Failures

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Handler Circuit Breakers                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Configuration (per handler):                                        │
│  ├── timeout: 60000ms (60s execution timeout)                       │
│  ├── errorThresholdPercentage: 50%                                  │
│  ├── resetTimeout: 30000ms (try again after 30s)                    │
│  └── volumeThreshold: 5 (need 5 calls to calculate rate)            │
│                                                                      │
│  State Machine:                                                      │
│                                                                      │
│    ┌────────┐    50% failures    ┌────────┐   30s timeout  ┌─────────┐
│    │ CLOSED │ ─────────────────▶ │  OPEN  │ ────────────▶ │HALF-OPEN│
│    └────────┘                    └────────┘               └─────────┘
│        ▲                                                       │
│        │                                                       │
│        └────── success ◄───────────────────────────────────────┘
│        └────── failure ──▶ back to OPEN
│                                                                      │
│  Events:                                                             │
│  • 'open'     ──▶ metric=1, log warning                             │
│  • 'halfOpen' ──▶ metric=0.5                                        │
│  • 'close'    ──▶ metric=0, log info                                │
│                                                                      │
│  execute(executionData):                                             │
│    │                                                                 │
│    ├── try: breaker.fire(payload) ──▶ return result                 │
│    │                                                                 │
│    └── catch:                                                        │
│          │                                                           │
│          ├── error.code === 'EOPENBREAKER':                         │
│          │     log "Circuit open, requeueing"                       │
│          │     queue.enqueue(data, priority - 10)  (lower priority) │
│          │     throw CircuitOpenError                               │
│          │                                                           │
│          └── else: throw error                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Idempotency Layer

### Request-Level Idempotency

```
┌─────────────────────────────────────────────────────────────────────┐
│                    idempotencyMiddleware                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Options:                                                            │
│  ├── ttl: 3600 (cache TTL in seconds)                               │
│  └── keyHeader: 'Idempotency-Key'                                   │
│                                                                      │
│  Flow:                                                               │
│    │                                                                 │
│    ├── idempotencyKey = req.headers['idempotency-key']              │
│    │     if missing ──▶ next() (no idempotency)                     │
│    │                                                                 │
│    ├── cacheKey = "idempotency:{key}"                               │
│    │                                                                 │
│    ├── Check cache:                                                 │
│    │     GET cacheKey ──▶ if exists, return cached response         │
│    │                                                                 │
│    ├── Acquire processing lock:                                     │
│    │     lockKey = "idempotency:lock:{key}"                         │
│    │     SET lockKey '1' NX EX 60                                   │
│    │       │                                                         │
│    │       └── not acquired ──▶ 409 "Request already processing"   │
│    │                                                                 │
│    ├── Capture response:                                            │
│    │     Override res.json() to:                                    │
│    │       • Cache successful responses (2xx)                       │
│    │       • Release lock                                           │
│    │                                                                 │
│    └── next()                                                        │
│                                                                      │
│  Applied to:                                                         │
│    POST /api/v1/jobs [authenticate, authorize('admin'), idempotency] │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Worker Implementation

### Stateless Worker Pool

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Worker Architecture                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Worker State:                                                       │
│  ├── workerId: "worker-{uuid.slice(0,8)}"                           │
│  ├── concurrency: 5 (configurable)                                  │
│  ├── activeJobs: 0                                                  │
│  └── running: boolean                                               │
│                                                                      │
│  start():                                                            │
│    ├── Register in job_scheduler:workers hash                       │
│    ├── Start heartbeat (every 5s)                                   │
│    └── Start {concurrency} worker loops                             │
│                                                                      │
│  workerLoop(slot):                                                   │
│    │                                                                 │
│    ├── queue.dequeue(workerId)                                      │
│    │     if null ──▶ sleep(100ms), continue                         │
│    │                                                                 │
│    ├── activeJobs++                                                 │
│    │   metrics.activeJobs.set({worker}, activeJobs)                 │
│    │                                                                 │
│    ├── try: processExecution(data)                                  │
│    │                                                                 │
│    └── finally: activeJobs--                                        │
│                                                                      │
│  processExecution(executionData):                                    │
│    │                                                                 │
│    ├── [1] UPDATE job_executions                                    │
│    │       SET status='RUNNING', started_at=NOW(), worker_id        │
│    │                                                                 │
│    ├── [2] try:                                                      │
│    │       ├── executeWithDeduplication(data, workerId)             │
│    │       ├── result = handlerExecutor.execute(data)               │
│    │       ├── UPDATE status='COMPLETED', result=JSON(result)       │
│    │       ├── queue.complete(executionId, workerId)                │
│    │       └── metrics.executionDuration.observe({handler}, dur)    │
│    │                                                                 │
│    └── [3] catch error:                                              │
│            ├── if CircuitOpenError ──▶ return (already requeued)    │
│            └── handleFailure(executionId, error)                    │
│                                                                      │
│  heartbeat() (every 5s):                                             │
│    HSET job_scheduler:workers workerId JSON({                       │
│      lastHeartbeat, activeJobs, status: 'active'                    │
│    })                                                                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 9: Data Lifecycle Management

### Archival Process

A daily maintenance pass keeps the hot tables small. Because `job_executions` is range-partitioned by month, aging data out is a metadata operation rather than a mass delete:

1. Find partitions whose range ends more than 30 days ago.
2. Export each one to Parquet and upload it to object storage.
3. Record the partition name, date range, row count, file path, size, and checksum in `execution_archives`.
4. `DETACH PARTITION`, then drop the table.

Execution logs are the highest-volume data and the least useful once a job is known-good, so they're deleted outright after 7 days rather than archived.

> "Detaching a partition is O(1) — it's a catalog update, and the table disappears from the planner's view instantly. The alternative, `DELETE FROM job_executions WHERE created_at < …`, would rewrite millions of rows, bloat the table until autovacuum caught up, and hold locks that contend with the scheduler's own scan the entire time. Partitioning costs us the discipline of pre-creating next month's partition — and if that ever gets missed, inserts fail outright — which is why partition creation runs in the same maintenance job that does the archiving."

---

## Step 10: Monitoring and Metrics

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Prometheus Metrics                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Counters:                                                           │
│  ├── job_scheduler_jobs_enqueued_total    (labels: handler)         │
│  ├── job_scheduler_jobs_completed_total   (labels: handler)         │
│  └── job_scheduler_jobs_failed_total      (labels: handler)         │
│                                                                      │
│  Histograms:                                                         │
│  └── job_scheduler_execution_duration_seconds                       │
│      labels: handler                                                 │
│      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300]                     │
│                                                                      │
│  Gauges:                                                             │
│  ├── job_scheduler_queue_depth            (current queue size)      │
│  ├── job_scheduler_circuit_breaker_state  (labels: handler)         │
│  │   (0=closed, 0.5=half-open, 1=open)                              │
│  └── job_scheduler_scheduler_is_leader    (1 if leader, 0 if not)   │
│                                                                      │
│  Endpoint:                                                           │
│    GET /metrics ──▶ registry.metrics()                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| Redis leader election (SET NX EX) | Simple, automatic failover | Single scheduler active (no parallel scanning) |
| Redis sorted set for queue | O(log n) insert, O(1) pop, priority ordering | Memory-bound, not durable |
| Visibility timeout | Guarantees at-least-once | Possible duplicates if timeout too short |
| Separate scheduler/worker | Independent scaling, clear separation | More processes to manage |
| PostgreSQL for jobs | ACID, complex queries | Scaling limits at very high volume |
| Partitioned executions | Efficient archival, query performance | Partition management overhead |

---

## Closing Summary

"I've designed a distributed job scheduler backend with:

1. **Leader-elected scheduler** using Redis SET NX EX for distributed coordination
2. **Priority queue** with visibility timeout ensuring at-least-once execution
3. **Exponential backoff retries** with jitter and dead letter queue for failures
4. **Circuit breakers** per handler to prevent cascading failures
5. **Idempotency layer** for request deduplication
6. **Data lifecycle management** with partitioning and archival to cold storage

The key insight is separating concerns: the scheduler handles timing, the queue handles distribution with reliability guarantees, workers handle execution with circuit breakers. Each component can scale independently while maintaining consistency through distributed locks."
