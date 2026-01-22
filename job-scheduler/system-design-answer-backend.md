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

```
┌─────────────────────────────────────────────────────────────────────┐
│                             jobs                                     │
├─────────────────────────────────────────────────────────────────────┤
│  id                UUID PRIMARY KEY                                 │
│  name              VARCHAR(255) NOT NULL UNIQUE                     │
│  description       TEXT                                             │
│  handler           VARCHAR(255) NOT NULL                            │
│  payload           JSONB DEFAULT '{}'                               │
│  schedule          VARCHAR(100) (cron expression)                   │
│  next_run_time     TIMESTAMP WITH TIME ZONE                         │
│  priority          INTEGER DEFAULT 50 (0-100, higher = important)   │
│  max_retries       INTEGER DEFAULT 3                                │
│  initial_backoff_ms INTEGER DEFAULT 1000                            │
│  max_backoff_ms    INTEGER DEFAULT 3600000                          │
│  timeout_ms        INTEGER DEFAULT 300000                           │
│  status            job_status DEFAULT 'SCHEDULED'                   │
│  owner_id          UUID FK → users                                  │
│  created_at        TIMESTAMP WITH TIME ZONE                         │
│  updated_at        TIMESTAMP WITH TIME ZONE                         │
├─────────────────────────────────────────────────────────────────────┤
│  Indexes:                                                            │
│  • idx_jobs_next_run ON (next_run_time) WHERE status = 'SCHEDULED'  │
│  • idx_jobs_status ON (status)                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        job_executions                                │
│                   PARTITION BY RANGE (created_at)                    │
├─────────────────────────────────────────────────────────────────────┤
│  id                UUID PRIMARY KEY                                 │
│  job_id            UUID FK → jobs                                   │
│  status            execution_status NOT NULL                        │
│  attempt           INTEGER DEFAULT 1                                │
│  scheduled_at      TIMESTAMP WITH TIME ZONE                         │
│  started_at        TIMESTAMP WITH TIME ZONE                         │
│  completed_at      TIMESTAMP WITH TIME ZONE                         │
│  next_retry_at     TIMESTAMP WITH TIME ZONE                         │
│  result            JSONB                                            │
│  error             TEXT                                             │
│  worker_id         VARCHAR(100)                                     │
│  created_at        TIMESTAMP WITH TIME ZONE                         │
├─────────────────────────────────────────────────────────────────────┤
│  Monthly partitions: job_executions_2024_01, job_executions_2024_02 │
│  Indexes:                                                            │
│  • idx_executions_job_id ON (job_id)                                │
│  • idx_executions_status ON (status)                                │
│  • idx_executions_next_retry ON (next_retry_at)                     │
│    WHERE status = 'PENDING_RETRY'                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        execution_logs                                │
├─────────────────────────────────────────────────────────────────────┤
│  id                UUID PRIMARY KEY                                 │
│  execution_id      UUID FK → job_executions                         │
│  level             VARCHAR(10) NOT NULL                             │
│  message           TEXT NOT NULL                                    │
│  metadata          JSONB                                            │
│  created_at        TIMESTAMP WITH TIME ZONE                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      execution_archives                              │
├─────────────────────────────────────────────────────────────────────┤
│  id                UUID PRIMARY KEY                                 │
│  partition_name    VARCHAR(50) NOT NULL                             │
│  start_date        DATE NOT NULL                                    │
│  end_date          DATE NOT NULL                                    │
│  record_count      INTEGER NOT NULL                                 │
│  file_path         VARCHAR(500) NOT NULL                            │
│  file_size_bytes   BIGINT NOT NULL                                  │
│  checksum          VARCHAR(64) NOT NULL                             │
│  archived_at       TIMESTAMP WITH TIME ZONE                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Redis Data Structures

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Redis Key Schema                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Priority Queue:                                                     │
│    job_scheduler:queue ──▶ Sorted Set                               │
│    Member: execution_data_json                                       │
│    Score: 100 - priority (inverted for ZPOPMIN)                     │
│                                                                      │
│  Processing Set (Visibility Timeout):                                │
│    job_scheduler:processing ──▶ Sorted Set                          │
│    Member: {executionId}:{workerId}:{data}                          │
│    Score: timeout_timestamp                                         │
│                                                                      │
│  Dead Letter Queue:                                                  │
│    job_scheduler:dead_letter ──▶ List                               │
│    Value: execution_data_json with error and failedAt               │
│    TTL: 30 days                                                      │
│                                                                      │
│  Leader Election:                                                    │
│    job_scheduler:scheduler:leader ──▶ String                        │
│    Value: instance_id                                               │
│    TTL: 30 seconds (EX 30)                                          │
│                                                                      │
│  Job Locks (Deduplication):                                          │
│    job_scheduler:lock:{job_id} ──▶ String                           │
│    Value: execution_id                                              │
│    TTL: 1 hour (EX 3600)                                            │
│                                                                      │
│  Worker Registry:                                                    │
│    job_scheduler:workers ──▶ Hash                                   │
│    Field: worker_id                                                 │
│    Value: {startedAt, concurrency, status, lastHeartbeat}           │
│                                                                      │
│  Idempotency:                                                        │
│    idempotency:{key} ──▶ String                                     │
│    Value: response_json                                             │
│    TTL: 1 hour (EX 3600)                                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

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

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DataLifecycleManager                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  runDailyMaintenance():                                              │
│    ├── archiveOldExecutions()                                       │
│    ├── cleanupLogs()                                                │
│    └── vacuumTables()                                               │
│                                                                      │
│  archiveOldExecutions():                                             │
│    │                                                                 │
│    ├── Find partitions older than 30 days:                          │
│    │   SELECT tablename FROM pg_tables                              │
│    │   WHERE tablename LIKE 'job_executions_%'                      │
│    │     AND tablename < 'job_executions_{30_days_ago}'             │
│    │                                                                 │
│    └── For each old partition:                                      │
│          │                                                           │
│          ├── Export to Parquet                                      │
│          │   data = SELECT * FROM {partition}                       │
│          │   parquetBuffer = convertToParquet(data)                 │
│          │                                                           │
│          ├── Upload to MinIO                                        │
│          │   s3Path = "executions/{partition}.parquet"              │
│          │   minio.putObject('job-scheduler-archive', s3Path, buf)  │
│          │                                                           │
│          ├── Record archive metadata                                │
│          │   INSERT INTO execution_archives                         │
│          │   (partition_name, start_date, end_date, record_count,   │
│          │    file_path, file_size_bytes, checksum)                 │
│          │                                                           │
│          └── Drop partition                                         │
│              ALTER TABLE job_executions DETACH PARTITION {name}     │
│              DROP TABLE {name}                                       │
│                                                                      │
│  cleanupLogs():                                                      │
│    DELETE FROM execution_logs                                        │
│    WHERE created_at < NOW() - INTERVAL '7 days'                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

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
