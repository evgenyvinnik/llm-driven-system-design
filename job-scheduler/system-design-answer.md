# Job Scheduler - System Design Interview Answer

## Opening Statement

"Today I'll design a distributed job scheduler, similar to systems like AWS Step Functions, Airflow, or internal schedulers at large companies. The key challenges are ensuring at-least-once execution, handling failures gracefully, managing job priorities, and coordinating work across a distributed cluster while avoiding duplicate execution."

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

### Out of Scope

- Specific job execution environments (Docker, Lambda)
- Complex workflow orchestration (DAGs beyond simple dependencies)
- Multi-tenant isolation

---

## Step 2: Scale Estimation (2-3 minutes)

**Job volume:**
- 1 million jobs submitted per day
- 12 jobs/second average, 50 jobs/second peak
- Average job duration: 30 seconds
- Max concurrent jobs: 10,000

**Storage:**
- Job record: ~2KB (metadata, parameters, history)
- 1M jobs/day * 365 days * 2KB = 730 GB/year
- Keep detailed history for 90 days, summary for 2 years

**Workers:**
- 10K concurrent jobs / 100 jobs per worker = 100 workers minimum
- Add 50% headroom = 150 workers

**Key insight**: The challenge is coordination - ensuring jobs run exactly once, on time, with proper priority ordering, across a distributed system.

---

## Step 3: High-Level Architecture (10 minutes)

```
                              ┌─────────────────────────────────┐
                              │         Job Clients             │
                              │    (Submit, Query, Cancel)      │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │           API Gateway           │
                              │     (Auth, Rate Limiting)       │
                              └───────────────┬─────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │   Job Manager     │          │   Job Manager     │          │   Job Manager     │
    │   Service         │          │   Service         │          │   Service         │
    │                   │          │                   │          │                   │
    │ - CRUD operations │          │ - CRUD operations │          │ - CRUD operations │
    │ - Validation      │          │ - Validation      │          │ - Validation      │
    └─────────┬─────────┘          └─────────┬─────────┘          └─────────┬─────────┘
              │                               │                               │
              └───────────────────────────────┼───────────────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │          PostgreSQL             │
                              │      (Job definitions,          │
                              │       execution history)        │
                              └───────────────┬─────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │     Scheduler     │          │     Scheduler     │          │     Scheduler     │
    │     (Leader)      │          │    (Standby)      │          │    (Standby)      │
    │                   │          │                   │          │                   │
    │ - Time-based scan │          │ - Watches leader  │          │ - Watches leader  │
    │ - Queue insertion │          │                   │          │                   │
    └─────────┬─────────┘          └───────────────────┘          └───────────────────┘
              │
              ▼
    ┌───────────────────────────────────────────────────────────────────────────────┐
    │                            Priority Queues (Redis)                            │
    │                                                                               │
    │   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐              │
    │   │  Critical │   │   High    │   │  Normal   │   │    Low    │              │
    │   │  Priority │   │  Priority │   │  Priority │   │  Priority │              │
    │   └───────────┘   └───────────┘   └───────────┘   └───────────┘              │
    └───────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
    ┌───────────────────────────────────────────────────────────────────────────────┐
    │                              Worker Pool                                       │
    │                                                                               │
    │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
    │   │ Worker 1 │   │ Worker 2 │   │ Worker 3 │   │ Worker 4 │   │ Worker N │   │
    │   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
    └───────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Job Manager Service**
   - Handles job CRUD operations
   - Validates job definitions
   - Manages job lifecycle

2. **Scheduler Service**
   - Leader-elected component
   - Scans for due jobs
   - Inserts jobs into priority queues

3. **Priority Queues (Redis)**
   - Multiple priority levels
   - Reliable queue with visibility timeout
   - Dead letter queue for failed jobs

4. **Worker Pool**
   - Stateless job executors
   - Pull work from queues
   - Report completion/failure

5. **PostgreSQL**
   - Job definitions and metadata
   - Execution history
   - Source of truth for job state

---

## Step 4: Deep Dive - Distributed Scheduling (10 minutes)

### The Challenge

How do we ensure:
1. Jobs run at their scheduled time (not early, not late)
2. Each job runs exactly once (no duplicates, no misses)
3. System remains available if nodes fail

### Scheduler Design

**Leader Election using Redis:**

```typescript
class Scheduler {
  private isLeader = false;
  private leaderLockKey = 'scheduler:leader';
  private lockTTL = 30; // seconds

  async tryBecomeLeader(): Promise<boolean> {
    const acquired = await redis.set(
      this.leaderLockKey,
      this.instanceId,
      'NX',  // Only set if not exists
      'EX', this.lockTTL
    );
    this.isLeader = acquired === 'OK';
    return this.isLeader;
  }

  async maintainLeadership(): Promise<void> {
    if (this.isLeader) {
      // Extend lock TTL
      const extended = await redis.set(
        this.leaderLockKey,
        this.instanceId,
        'XX',  // Only if exists
        'EX', this.lockTTL
      );
      if (extended !== 'OK') {
        this.isLeader = false;
      }
    }
  }
}
```

**Job Scanning Loop:**

```typescript
async function schedulerLoop() {
  while (true) {
    if (!isLeader) {
      await sleep(1000);
      await tryBecomeLeader();
      continue;
    }

    await maintainLeadership();

    // Scan for due jobs
    const dueJobs = await db.query(`
      SELECT * FROM jobs
      WHERE status = 'SCHEDULED'
        AND next_run_time <= NOW()
        AND next_run_time > NOW() - INTERVAL '5 minutes'
      ORDER BY next_run_time
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    `);

    for (const job of dueJobs) {
      // Create execution record
      const execution = await createExecution(job);

      // Enqueue for workers
      await enqueueJob(job.priority, execution.id);

      // Update job status
      await updateJobStatus(job.id, 'QUEUED');
    }

    await sleep(100); // Scan every 100ms
  }
}
```

### Handling Recurring Jobs

```typescript
interface Job {
  id: string;
  name: string;
  schedule: string;  // Cron expression or ISO interval
  next_run_time: Date;
  status: 'SCHEDULED' | 'QUEUED' | 'RUNNING' | 'PAUSED';
}

async function completeExecution(executionId: string) {
  const execution = await getExecution(executionId);
  const job = await getJob(execution.job_id);

  // Calculate next run time
  if (job.schedule) {
    const nextRun = cronParser.next(job.schedule);
    await db.update('jobs', job.id, {
      next_run_time: nextRun,
      status: 'SCHEDULED'
    });
  }
}
```

### Time-Based Partitioning

For high-volume scheduling, partition by time:

```
┌─────────────────────────────────────────────────────────────┐
│                     Time Wheel                              │
│                                                             │
│   Slot 0      Slot 1      Slot 2      ...      Slot 59     │
│   (min 0)    (min 1)     (min 2)              (min 59)     │
│   [jobs]     [jobs]      [jobs]               [jobs]       │
│                                                             │
│   Each scheduler instance handles a subset of slots        │
└─────────────────────────────────────────────────────────────┘
```

- Jobs assigned to slots based on scheduled minute
- Multiple schedulers can process different slots
- Reduces contention on database scans

---

## Step 5: Deep Dive - Reliable Execution (8 minutes)

### At-Least-Once Guarantee

The system must guarantee every scheduled job runs at least once.

**Queue with Visibility Timeout:**

```typescript
// Redis-based reliable queue
class ReliableQueue {
  private queueKey: string;
  private processingKey: string;

  async enqueue(jobId: string, priority: number): Promise<void> {
    // Add to sorted set with priority as score
    await redis.zadd(this.queueKey, priority, jobId);
  }

  async dequeue(workerId: string): Promise<string | null> {
    // Atomically move from queue to processing
    const jobId = await redis.zpopmin(this.queueKey);
    if (!jobId) return null;

    // Add to processing set with timeout
    const timeout = Date.now() + 300000; // 5 minutes
    await redis.zadd(this.processingKey, timeout, `${jobId}:${workerId}`);

    return jobId;
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    await redis.zrem(this.processingKey, `${jobId}:${workerId}`);
  }

  async recoverStalled(): Promise<void> {
    // Find jobs past their timeout
    const stalled = await redis.zrangebyscore(
      this.processingKey,
      '-inf',
      Date.now()
    );

    for (const item of stalled) {
      const [jobId] = item.split(':');
      // Re-enqueue for retry
      await this.enqueue(jobId, RETRY_PRIORITY);
      await redis.zrem(this.processingKey, item);
    }
  }
}
```

### Worker Execution Flow

```typescript
async function workerLoop() {
  while (true) {
    // Pull job from queue (highest priority first)
    const executionId = await queue.dequeue(workerId);
    if (!executionId) {
      await sleep(100);
      continue;
    }

    try {
      // Update status to RUNNING
      await updateExecution(executionId, { status: 'RUNNING', started_at: now() });

      // Execute the job
      const result = await executeJob(executionId);

      // Mark complete
      await updateExecution(executionId, {
        status: 'COMPLETED',
        completed_at: now(),
        result: result
      });
      await queue.complete(executionId, workerId);

    } catch (error) {
      // Handle failure
      await handleFailure(executionId, error);
    }
  }
}
```

### Retry Logic with Exponential Backoff

```typescript
async function handleFailure(executionId: string, error: Error) {
  const execution = await getExecution(executionId);
  const job = await getJob(execution.job_id);

  if (execution.attempt < job.max_retries) {
    // Calculate backoff
    const backoff = Math.min(
      job.initial_backoff * Math.pow(2, execution.attempt),
      job.max_backoff
    );

    // Schedule retry
    await updateExecution(executionId, {
      status: 'PENDING_RETRY',
      next_retry_at: now() + backoff,
      last_error: error.message
    });

  } else {
    // Max retries exceeded - move to dead letter queue
    await updateExecution(executionId, {
      status: 'FAILED',
      last_error: error.message
    });
    await deadLetterQueue.add(executionId);
    await alerting.notify('job_failed', { executionId, error });
  }
}
```

### Exactly-Once Semantics

True exactly-once is hard. We achieve it through:

1. **Idempotency keys**: Jobs include idempotency token
2. **Deduplication window**: Check if job ran recently
3. **Distributed locks**: Lock on job ID during execution

```typescript
async function executeWithDedup(executionId: string) {
  const execution = await getExecution(executionId);

  // Try to acquire lock
  const lockKey = `job_lock:${execution.job_id}`;
  const acquired = await redis.set(lockKey, executionId, 'NX', 'EX', 3600);

  if (!acquired) {
    // Another execution is running or completed recently
    const holderId = await redis.get(lockKey);
    if (holderId !== executionId) {
      await updateExecution(executionId, { status: 'DEDUPLICATED' });
      return;
    }
  }

  try {
    await executeJob(executionId);
  } finally {
    // Keep lock for dedup window, then release
    // Or: await redis.del(lockKey);
  }
}
```

---

## Step 6: Deep Dive - Job Dependencies (5 minutes)

### Dependency Model

```typescript
interface Job {
  id: string;
  dependencies: string[];  // IDs of jobs that must complete first
  dependent_jobs: string[];  // Jobs that depend on this one
}

interface Execution {
  id: string;
  job_id: string;
  parent_execution_id: string | null;  // For dependent executions
  status: ExecutionStatus;
}
```

### Dependency Resolution

```typescript
async function onJobComplete(executionId: string) {
  const execution = await getExecution(executionId);
  const job = await getJob(execution.job_id);

  // Find jobs that depend on this one
  for (const dependentJobId of job.dependent_jobs) {
    await checkAndTriggerDependent(dependentJobId, execution);
  }
}

async function checkAndTriggerDependent(
  jobId: string,
  completedExecution: Execution
) {
  const job = await getJob(jobId);

  // Check if all dependencies are satisfied
  const dependencies = await Promise.all(
    job.dependencies.map(depId => getLatestExecution(depId))
  );

  const allCompleted = dependencies.every(
    exec => exec?.status === 'COMPLETED'
  );

  if (allCompleted) {
    // Trigger this job
    const execution = await createExecution(job, {
      triggered_by: completedExecution.id
    });
    await enqueueJob(job.priority, execution.id);
  }
}
```

### DAG Visualization

For complex dependencies, represent as directed graph:

```
       Job A
      /     \
   Job B   Job C
      \     /
       Job D
         |
       Job E
```

- Job D runs only after both B and C complete
- Cycle detection required at job creation time

---

## Step 7: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Job definitions
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  handler VARCHAR(255) NOT NULL,  -- Function/endpoint to call
  payload JSONB,                   -- Job parameters
  schedule VARCHAR(100),           -- Cron expression
  next_run_time TIMESTAMP,
  priority INTEGER DEFAULT 50,
  max_retries INTEGER DEFAULT 3,
  initial_backoff_ms INTEGER DEFAULT 1000,
  max_backoff_ms INTEGER DEFAULT 3600000,
  timeout_ms INTEGER DEFAULT 300000,
  status VARCHAR(20) DEFAULT 'SCHEDULED',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Job dependencies
CREATE TABLE job_dependencies (
  job_id UUID REFERENCES jobs(id),
  depends_on_job_id UUID REFERENCES jobs(id),
  PRIMARY KEY (job_id, depends_on_job_id)
);

-- Job executions
CREATE TABLE job_executions (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  status VARCHAR(20) NOT NULL,
  attempt INTEGER DEFAULT 1,
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  result JSONB,
  error TEXT,
  worker_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_jobs_next_run ON jobs(next_run_time) WHERE status = 'SCHEDULED';
CREATE INDEX idx_executions_job_id ON job_executions(job_id);
CREATE INDEX idx_executions_status ON job_executions(status);
```

### Redis Data Structures

```
Priority Queues:
  queue:critical  → Sorted Set (job_id, priority_score)
  queue:high      → Sorted Set
  queue:normal    → Sorted Set
  queue:low       → Sorted Set

Processing:
  processing:{queue_name} → Sorted Set (job_id:worker_id, timeout)

Locks:
  lock:scheduler:leader → String (instance_id)
  lock:job:{job_id}     → String (execution_id)

Metrics:
  metrics:jobs:enqueued  → Counter
  metrics:jobs:completed → Counter
  metrics:jobs:failed    → Counter
```

---

## Step 8: API Design (2 minutes)

### REST API

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
GET    /api/v1/metrics                 - System metrics
GET    /api/v1/health                  - Health check
```

### Job Definition Example

```json
POST /api/v1/jobs
{
  "name": "daily-report",
  "description": "Generate daily sales report",
  "handler": "reports.generate_daily",
  "payload": {
    "report_type": "sales",
    "format": "pdf"
  },
  "schedule": "0 6 * * *",
  "priority": 75,
  "max_retries": 3,
  "timeout_ms": 600000
}
```

---

## Step 9: Monitoring and Observability (3 minutes)

### Key Metrics

```typescript
const metrics = {
  // Throughput
  jobs_enqueued_total: Counter,
  jobs_completed_total: Counter,
  jobs_failed_total: Counter,

  // Latency
  job_queue_time_seconds: Histogram,     // Time in queue
  job_execution_time_seconds: Histogram, // Execution duration
  job_schedule_delay_seconds: Histogram, // Delay from scheduled time

  // System health
  queue_depth: Gauge,           // Jobs waiting per queue
  workers_active: Gauge,        // Currently executing
  scheduler_lag_seconds: Gauge, // How behind scheduler is
};
```

### Alerting Rules

```yaml
alerts:
  - name: HighQueueDepth
    condition: queue_depth > 10000
    for: 5m
    severity: warning

  - name: HighFailureRate
    condition: rate(jobs_failed_total[5m]) / rate(jobs_completed_total[5m]) > 0.1
    severity: critical

  - name: SchedulerLag
    condition: scheduler_lag_seconds > 60
    severity: critical

  - name: WorkerStarvation
    condition: workers_active == 0 && queue_depth > 0
    for: 2m
    severity: critical
```

### Dashboard Views

1. **Overview**: Jobs running, completed, failed (last hour)
2. **Queue Health**: Depth and throughput per priority
3. **Worker Status**: Active workers, utilization
4. **Job Details**: Drill down to specific job history

---

## Step 10: Scalability (2 minutes)

### Horizontal Scaling

1. **Job Managers**: Stateless, scale with API traffic
2. **Schedulers**: Leader-elected, only one active
3. **Workers**: Scale with job volume
4. **Queue**: Redis Cluster for high throughput

### Worker Auto-scaling

```typescript
async function autoScaleWorkers() {
  const queueDepth = await getQueueDepth();
  const activeWorkers = await getActiveWorkers();
  const avgJobDuration = await getAvgJobDuration();

  // Target: clear queue in 5 minutes
  const targetThroughput = queueDepth / 300; // jobs per second
  const workersNeeded = targetThroughput * avgJobDuration;

  if (workersNeeded > activeWorkers * 1.2) {
    await scaleUp(Math.ceil(workersNeeded - activeWorkers));
  } else if (workersNeeded < activeWorkers * 0.5) {
    await scaleDown(Math.floor(activeWorkers - workersNeeded));
  }
}
```

### Database Scaling

- Read replicas for execution history queries
- Partition executions by date (monthly)
- Archive old executions to cold storage

---

## Step 11: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Redis queues | Fast, but memory-bound |
| Leader election | Simple, but single scheduler |
| Visibility timeout | At-least-once, but possible duplicates |
| PostgreSQL for state | ACID, but scaling limits |

### Alternatives Considered

1. **Kafka instead of Redis**
   - Better durability
   - More operational complexity
   - Chose Redis for simplicity

2. **Database polling instead of queues**
   - Simpler architecture
   - Higher database load
   - Doesn't scale as well

3. **Fully distributed scheduling**
   - No single point of failure
   - More complex coordination
   - Leader pattern simpler to implement correctly

---

## Closing Summary

"I've designed a distributed job scheduler with:

1. **Leader-elected scheduler** for reliable job triggering
2. **Priority-based queues** with visibility timeout for at-least-once execution
3. **Exponential backoff retries** with dead letter queue for failures
4. **Dependency resolution** for job chains and DAGs

The key insight is separating concerns: the scheduler handles timing, queues handle distribution, workers handle execution. This allows each component to scale independently. Happy to discuss any component in more detail."

---

## Potential Follow-up Questions

1. **How would you handle time zone-aware scheduling?**
   - Store schedule in user's timezone
   - Convert to UTC for internal scheduling
   - Handle DST transitions carefully

2. **How would you implement job rate limiting?**
   - Token bucket per job type
   - Sliding window counters in Redis
   - Configurable per-tenant limits

3. **How would you support sub-second scheduling?**
   - In-memory scheduling with time wheels
   - Higher precision timers
   - Dedicated low-latency queue
