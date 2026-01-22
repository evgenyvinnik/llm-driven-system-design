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

```sql
-- Job definitions with scheduling and retry configuration
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  handler VARCHAR(255) NOT NULL,
  payload JSONB DEFAULT '{}',
  schedule VARCHAR(100),           -- Cron expression
  next_run_time TIMESTAMP WITH TIME ZONE,
  priority INTEGER DEFAULT 50,     -- 0-100, higher = more important
  max_retries INTEGER DEFAULT 3,
  initial_backoff_ms INTEGER DEFAULT 1000,
  max_backoff_ms INTEGER DEFAULT 3600000,
  timeout_ms INTEGER DEFAULT 300000,
  status job_status DEFAULT 'SCHEDULED',
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Job executions with full lifecycle tracking
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
) PARTITION BY RANGE (created_at);

-- Monthly partitions for execution history
CREATE TABLE job_executions_2024_01 PARTITION OF job_executions
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Execution logs for debugging
CREATE TABLE execution_logs (
  id UUID PRIMARY KEY,
  execution_id UUID REFERENCES job_executions(id),
  level VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Archive tracking for cold storage
CREATE TABLE execution_archives (
  id UUID PRIMARY KEY,
  partition_name VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  record_count INTEGER NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Critical indexes for scheduler performance
CREATE INDEX idx_jobs_next_run ON jobs(next_run_time)
  WHERE status = 'SCHEDULED';
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_executions_job_id ON job_executions(job_id);
CREATE INDEX idx_executions_status ON job_executions(status);
CREATE INDEX idx_executions_next_retry ON job_executions(next_retry_at)
  WHERE status = 'PENDING_RETRY';
```

### Redis Data Structures

```
Priority Queue:
  job_scheduler:queue → Sorted Set (execution_id, inverted_priority)
  # Higher priority (100) stored as lower score for ZPOPMIN

Processing Set:
  job_scheduler:processing → Sorted Set (execution_id:worker_id, timeout_timestamp)
  # Visibility timeout tracking

Dead Letter Queue:
  job_scheduler:dead_letter → List (execution_data_json)

Leader Election:
  job_scheduler:scheduler:leader → String (instance_id, EX 30)

Job Locks:
  job_scheduler:lock:{job_id} → String (execution_id, EX 3600)

Worker Registry:
  job_scheduler:workers → Hash (worker_id → status_json)

Idempotency:
  idempotency:{key} → String (response_json, EX 3600)
```

---

## Step 3: Leader Election for Scheduler

### The Challenge

Only one scheduler should be active to prevent duplicate job enqueueing, but we need automatic failover if the leader dies.

### Redis-Based Leader Election

```typescript
class Scheduler {
  private isLeader = false;
  private readonly instanceId = crypto.randomUUID();
  private readonly leaderKey = 'job_scheduler:scheduler:leader';
  private readonly lockTTL = 30; // seconds
  private readonly heartbeatInterval = 10; // seconds

  async start(): Promise<void> {
    // Attempt to become leader on startup
    await this.tryAcquireLeadership();

    // Start heartbeat loop
    setInterval(() => this.heartbeat(), this.heartbeatInterval * 1000);

    // Start scheduling loop
    this.schedulerLoop();
  }

  private async tryAcquireLeadership(): Promise<boolean> {
    // SET NX: only succeeds if key doesn't exist
    // EX: automatic expiration for fault tolerance
    const result = await redis.set(
      this.leaderKey,
      this.instanceId,
      'NX',
      'EX', this.lockTTL
    );

    this.isLeader = result === 'OK';

    if (this.isLeader) {
      logger.info('Acquired scheduler leadership', { instanceId: this.instanceId });
    }

    return this.isLeader;
  }

  private async heartbeat(): Promise<void> {
    if (this.isLeader) {
      // Extend our lock - only succeeds if we still hold it
      const result = await redis.set(
        this.leaderKey,
        this.instanceId,
        'XX',  // Only if exists
        'EX', this.lockTTL
      );

      if (result !== 'OK') {
        // Lost leadership (another instance took over during network partition)
        this.isLeader = false;
        logger.warn('Lost scheduler leadership', { instanceId: this.instanceId });
      }
    } else {
      // Try to become leader if current leader fails
      await this.tryAcquireLeadership();
    }
  }

  private async schedulerLoop(): Promise<void> {
    while (true) {
      if (!this.isLeader) {
        await sleep(1000);
        continue;
      }

      try {
        await this.scanAndEnqueueDueJobs();
        await this.recoverStalledExecutions();
        await this.scheduleRetries();
      } catch (error) {
        logger.error('Scheduler loop error', { error });
      }

      await sleep(100); // Scan every 100ms
    }
  }
}
```

### Scanning for Due Jobs

```typescript
async scanAndEnqueueDueJobs(): Promise<void> {
  // Use FOR UPDATE SKIP LOCKED to prevent race conditions
  // between multiple scheduler restarts
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
    const execution = await db.query(`
      INSERT INTO job_executions (id, job_id, status, scheduled_at, attempt)
      VALUES ($1, $2, 'PENDING', $3, 1)
      RETURNING *
    `, [crypto.randomUUID(), job.id, job.next_run_time]);

    // Enqueue with priority (inverted for ZPOPMIN)
    const score = 100 - job.priority;
    await redis.zadd('job_scheduler:queue', score, JSON.stringify({
      executionId: execution.id,
      jobId: job.id,
      handler: job.handler,
      payload: job.payload,
      timeout: job.timeout_ms,
    }));

    // Update job status and calculate next run time
    if (job.schedule) {
      const nextRun = cronParser.parseExpression(job.schedule).next().toDate();
      await db.query(`
        UPDATE jobs SET status = 'SCHEDULED', next_run_time = $1
        WHERE id = $2
      `, [nextRun, job.id]);
    } else {
      await db.query(`
        UPDATE jobs SET status = 'QUEUED'
        WHERE id = $1
      `, [job.id]);
    }
  }
}
```

---

## Step 4: Priority Queue with Visibility Timeout

### Queue Design for At-Least-Once Execution

```typescript
class ReliableQueue {
  private readonly queueKey = 'job_scheduler:queue';
  private readonly processingKey = 'job_scheduler:processing';
  private readonly deadLetterKey = 'job_scheduler:dead_letter';

  async enqueue(executionData: ExecutionData, priority: number): Promise<void> {
    // Store with inverted priority (higher priority = lower score)
    const score = 100 - priority;
    await redis.zadd(this.queueKey, score, JSON.stringify(executionData));

    metrics.jobsEnqueued.inc({ handler: executionData.handler });
  }

  async dequeue(workerId: string): Promise<ExecutionData | null> {
    // Atomically pop highest priority item
    const result = await redis.zpopmin(this.queueKey);
    if (!result || result.length === 0) {
      return null;
    }

    const [data, score] = result;
    const executionData = JSON.parse(data);

    // Add to processing set with visibility timeout
    const visibilityTimeout = Date.now() + (executionData.timeout || 300000);
    await redis.zadd(
      this.processingKey,
      visibilityTimeout,
      `${executionData.executionId}:${workerId}:${data}`
    );

    return executionData;
  }

  async complete(executionId: string, workerId: string): Promise<void> {
    // Find and remove from processing set
    const pattern = `${executionId}:${workerId}:*`;
    const members = await this.scanProcessingSet(pattern);

    for (const member of members) {
      await redis.zrem(this.processingKey, member);
    }

    metrics.jobsCompleted.inc();
  }

  async recoverStalled(): Promise<number> {
    // Find items past their visibility timeout
    const now = Date.now();
    const stalledItems = await redis.zrangebyscore(
      this.processingKey,
      '-inf',
      now
    );

    let recovered = 0;
    for (const item of stalledItems) {
      const [executionId, workerId, ...dataParts] = item.split(':');
      const data = dataParts.join(':');

      // Re-enqueue with elevated priority (retry sooner)
      await redis.zadd(this.queueKey, 0, data); // Highest priority
      await redis.zrem(this.processingKey, item);

      logger.warn('Recovered stalled execution', { executionId, workerId });
      recovered++;
    }

    return recovered;
  }

  async moveToDeadLetter(executionData: ExecutionData, error: string): Promise<void> {
    const deadLetterItem = {
      ...executionData,
      error,
      failedAt: new Date().toISOString(),
    };

    await redis.lpush(this.deadLetterKey, JSON.stringify(deadLetterItem));
    await redis.expire(this.deadLetterKey, 30 * 24 * 60 * 60); // 30 days TTL

    metrics.deadLetterSize.inc();
  }
}
```

### Deduplication with Distributed Locks

```typescript
async executeWithDeduplication(
  executionData: ExecutionData,
  workerId: string
): Promise<void> {
  const lockKey = `job_scheduler:lock:${executionData.jobId}`;

  // Try to acquire execution lock
  const acquired = await redis.set(
    lockKey,
    executionData.executionId,
    'NX',
    'EX', 3600 // 1 hour lock for deduplication window
  );

  if (!acquired) {
    // Another execution is in progress or recently completed
    const holder = await redis.get(lockKey);

    if (holder !== executionData.executionId) {
      // Mark as deduplicated and skip
      await db.query(`
        UPDATE job_executions
        SET status = 'DEDUPLICATED', completed_at = NOW()
        WHERE id = $1
      `, [executionData.executionId]);

      logger.info('Deduplicated execution', {
        executionId: executionData.executionId,
        existingExecution: holder,
      });
      return;
    }
  }

  // Execute the job
  await this.executeJob(executionData, workerId);
}
```

---

## Step 5: Retry Logic with Exponential Backoff

### Failure Handling

```typescript
async handleFailure(
  executionId: string,
  error: Error
): Promise<void> {
  const execution = await db.queryRow(`
    SELECT e.*, j.max_retries, j.initial_backoff_ms, j.max_backoff_ms,
           j.handler, j.payload, j.priority
    FROM job_executions e
    JOIN jobs j ON e.job_id = j.id
    WHERE e.id = $1
  `, [executionId]);

  if (execution.attempt < execution.max_retries) {
    // Calculate exponential backoff with jitter
    const baseBackoff = execution.initial_backoff_ms * Math.pow(2, execution.attempt);
    const cappedBackoff = Math.min(baseBackoff, execution.max_backoff_ms);
    const jitter = Math.random() * 0.3 * cappedBackoff; // 30% jitter
    const backoffMs = cappedBackoff + jitter;

    const nextRetryAt = new Date(Date.now() + backoffMs);

    await db.query(`
      UPDATE job_executions
      SET status = 'PENDING_RETRY',
          next_retry_at = $1,
          error = $2,
          attempt = attempt + 1
      WHERE id = $3
    `, [nextRetryAt, error.message, executionId]);

    logger.info('Scheduled retry', {
      executionId,
      attempt: execution.attempt + 1,
      maxRetries: execution.max_retries,
      nextRetryAt,
    });

    metrics.jobsRetried.inc({ handler: execution.handler });

  } else {
    // Max retries exceeded - move to dead letter queue
    await db.query(`
      UPDATE job_executions
      SET status = 'FAILED',
          error = $1,
          completed_at = NOW()
      WHERE id = $2
    `, [error.message, executionId]);

    await queue.moveToDeadLetter({
      executionId,
      jobId: execution.job_id,
      handler: execution.handler,
      payload: execution.payload,
    }, error.message);

    // Alert on job failure
    await alerting.notify('job_failed', {
      executionId,
      jobId: execution.job_id,
      handler: execution.handler,
      error: error.message,
      attempts: execution.attempt,
    });

    metrics.jobsFailed.inc({ handler: execution.handler });
  }
}
```

### Scheduler Retry Processing

```typescript
async scheduleRetries(): Promise<void> {
  // Find executions ready for retry
  const pendingRetries = await db.query(`
    SELECT e.*, j.handler, j.payload, j.priority
    FROM job_executions e
    JOIN jobs j ON e.job_id = j.id
    WHERE e.status = 'PENDING_RETRY'
      AND e.next_retry_at <= NOW()
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  `);

  for (const execution of pendingRetries) {
    // Update status and re-enqueue
    await db.query(`
      UPDATE job_executions
      SET status = 'PENDING', next_retry_at = NULL
      WHERE id = $1
    `, [execution.id]);

    await queue.enqueue({
      executionId: execution.id,
      jobId: execution.job_id,
      handler: execution.handler,
      payload: execution.payload,
      timeout: execution.timeout_ms,
      attempt: execution.attempt,
    }, execution.priority);
  }
}
```

---

## Step 6: Circuit Breaker Pattern

### Preventing Cascading Failures

```typescript
import CircuitBreaker from 'opossum';

class HandlerExecutor {
  private circuitBreakers = new Map<string, CircuitBreaker>();

  getOrCreateBreaker(handlerName: string): CircuitBreaker {
    if (!this.circuitBreakers.has(handlerName)) {
      const handler = this.handlers.get(handlerName);

      const breaker = new CircuitBreaker(handler.execute.bind(handler), {
        timeout: 60000,                // 60s execution timeout
        errorThresholdPercentage: 50,  // Open at 50% failure rate
        resetTimeout: 30000,           // Try again after 30s
        volumeThreshold: 5,            // Need 5 calls to calculate rate
      });

      // Metrics for circuit breaker state
      breaker.on('open', () => {
        metrics.circuitBreakerState.set({ handler: handlerName }, 1);
        logger.warn('Circuit breaker opened', { handler: handlerName });
      });

      breaker.on('halfOpen', () => {
        metrics.circuitBreakerState.set({ handler: handlerName }, 0.5);
      });

      breaker.on('close', () => {
        metrics.circuitBreakerState.set({ handler: handlerName }, 0);
        logger.info('Circuit breaker closed', { handler: handlerName });
      });

      this.circuitBreakers.set(handlerName, breaker);
    }

    return this.circuitBreakers.get(handlerName)!;
  }

  async execute(executionData: ExecutionData): Promise<any> {
    const breaker = this.getOrCreateBreaker(executionData.handler);

    try {
      return await breaker.fire(executionData.payload);
    } catch (error) {
      if (error.code === 'EOPENBREAKER') {
        // Circuit is open - requeue for later
        logger.info('Circuit open, requeueing', {
          executionId: executionData.executionId,
          handler: executionData.handler,
        });

        // Requeue with slight delay
        await queue.enqueue(executionData, executionData.priority - 10);

        // Don't count as failure for retry logic
        throw new CircuitOpenError(executionData.handler);
      }
      throw error;
    }
  }
}
```

---

## Step 7: Idempotency Layer

### Request-Level Idempotency

```typescript
interface IdempotencyMiddlewareOptions {
  ttl: number;        // Cache TTL in seconds
  keyHeader: string;  // Header name for idempotency key
}

function idempotencyMiddleware(options: IdempotencyMiddlewareOptions = {
  ttl: 3600,
  keyHeader: 'Idempotency-Key',
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers[options.keyHeader.toLowerCase()];

    if (!idempotencyKey) {
      return next();
    }

    const cacheKey = `idempotency:${idempotencyKey}`;

    // Check for cached response
    const cached = await redis.get(cacheKey);
    if (cached) {
      const { statusCode, body } = JSON.parse(cached);
      logger.debug('Returning cached idempotent response', { idempotencyKey });
      return res.status(statusCode).json(body);
    }

    // Acquire lock to prevent parallel processing
    const lockKey = `idempotency:lock:${idempotencyKey}`;
    const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 60);

    if (!acquired) {
      return res.status(409).json({
        error: 'Request with this idempotency key is already being processed',
      });
    }

    // Capture response for caching
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.setex(cacheKey, options.ttl, JSON.stringify({
          statusCode: res.statusCode,
          body,
        }));
      }
      redis.del(lockKey);
      return originalJson(body);
    };

    next();
  };
}

// Apply to job creation
app.post('/api/v1/jobs',
  authenticate,
  authorize('admin'),
  idempotencyMiddleware({ ttl: 3600, keyHeader: 'Idempotency-Key' }),
  createJobHandler
);
```

---

## Step 8: Worker Implementation

### Stateless Worker Pool

```typescript
class Worker {
  private readonly workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  private readonly concurrency: number;
  private activeJobs = 0;
  private running = false;

  constructor(concurrency: number = 5) {
    this.concurrency = concurrency;
  }

  async start(): Promise<void> {
    this.running = true;

    // Register with worker registry
    await this.registerWorker();

    // Start heartbeat
    setInterval(() => this.heartbeat(), 5000);

    // Start worker loops (one per concurrency slot)
    for (let i = 0; i < this.concurrency; i++) {
      this.workerLoop(i);
    }
  }

  private async workerLoop(slot: number): Promise<void> {
    while (this.running) {
      try {
        const executionData = await queue.dequeue(this.workerId);

        if (!executionData) {
          await sleep(100); // No work available
          continue;
        }

        this.activeJobs++;
        metrics.activeJobs.set({ worker: this.workerId }, this.activeJobs);

        try {
          await this.processExecution(executionData);
        } finally {
          this.activeJobs--;
          metrics.activeJobs.set({ worker: this.workerId }, this.activeJobs);
        }
      } catch (error) {
        logger.error('Worker loop error', { error, slot, workerId: this.workerId });
        await sleep(1000); // Back off on error
      }
    }
  }

  private async processExecution(executionData: ExecutionData): Promise<void> {
    const startTime = Date.now();

    // Update execution status
    await db.query(`
      UPDATE job_executions
      SET status = 'RUNNING', started_at = NOW(), worker_id = $1
      WHERE id = $2
    `, [this.workerId, executionData.executionId]);

    try {
      // Execute with deduplication check
      await executeWithDeduplication(executionData, this.workerId);

      // Execute through circuit breaker
      const result = await handlerExecutor.execute(executionData);

      // Mark complete
      await db.query(`
        UPDATE job_executions
        SET status = 'COMPLETED', completed_at = NOW(), result = $1
        WHERE id = $2
      `, [JSON.stringify(result), executionData.executionId]);

      await queue.complete(executionData.executionId, this.workerId);

      const duration = (Date.now() - startTime) / 1000;
      metrics.executionDuration.observe(
        { handler: executionData.handler },
        duration
      );

      logger.info('Job completed', {
        executionId: executionData.executionId,
        handler: executionData.handler,
        duration,
      });

    } catch (error) {
      if (error instanceof CircuitOpenError) {
        // Already requeued by circuit breaker
        return;
      }

      await handleFailure(executionData.executionId, error);
    }
  }

  private async registerWorker(): Promise<void> {
    await redis.hset('job_scheduler:workers', this.workerId, JSON.stringify({
      startedAt: new Date().toISOString(),
      concurrency: this.concurrency,
      status: 'active',
    }));
  }

  private async heartbeat(): Promise<void> {
    await redis.hset('job_scheduler:workers', this.workerId, JSON.stringify({
      lastHeartbeat: new Date().toISOString(),
      activeJobs: this.activeJobs,
      status: 'active',
    }));
  }
}
```

---

## Step 9: Data Lifecycle Management

### Archival Process

```typescript
class DataLifecycleManager {
  async runDailyMaintenance(): Promise<void> {
    await this.archiveOldExecutions();
    await this.cleanupLogs();
    await this.vacuumTables();
  }

  private async archiveOldExecutions(): Promise<void> {
    // Find partitions older than 30 days
    const oldPartitions = await db.query(`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE tablename LIKE 'job_executions_%'
        AND tablename < $1
    `, [`job_executions_${formatPartitionDate(subDays(new Date(), 30))}`]);

    for (const partition of oldPartitions) {
      // Export to Parquet and upload to MinIO
      const data = await db.query(`SELECT * FROM ${partition.tablename}`);

      const parquetBuffer = await convertToParquet(data);
      const s3Path = `executions/${partition.tablename}.parquet`;

      await minio.putObject('job-scheduler-archive', s3Path, parquetBuffer);

      // Record archive
      await db.query(`
        INSERT INTO execution_archives
        (id, partition_name, start_date, end_date, record_count, file_path, file_size_bytes, checksum)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        crypto.randomUUID(),
        partition.tablename,
        extractStartDate(partition.tablename),
        extractEndDate(partition.tablename),
        data.length,
        s3Path,
        parquetBuffer.length,
        crypto.createHash('sha256').update(parquetBuffer).digest('hex'),
      ]);

      // Detach and drop partition
      await db.query(`
        ALTER TABLE job_executions DETACH PARTITION ${partition.tablename}
      `);
      await db.query(`DROP TABLE ${partition.tablename}`);

      logger.info('Archived partition', { partition: partition.tablename });
    }
  }

  private async cleanupLogs(): Promise<void> {
    const result = await db.query(`
      DELETE FROM execution_logs
      WHERE created_at < NOW() - INTERVAL '7 days'
    `);

    logger.info('Cleaned up logs', { deleted: result.rowCount });
  }
}
```

---

## Step 10: Monitoring and Metrics

### Prometheus Metrics

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const registry = new Registry();

const metrics = {
  jobsEnqueued: new Counter({
    name: 'job_scheduler_jobs_enqueued_total',
    help: 'Total number of jobs enqueued',
    labelNames: ['handler'],
    registers: [registry],
  }),

  jobsCompleted: new Counter({
    name: 'job_scheduler_jobs_completed_total',
    help: 'Total number of jobs completed',
    labelNames: ['handler'],
    registers: [registry],
  }),

  jobsFailed: new Counter({
    name: 'job_scheduler_jobs_failed_total',
    help: 'Total number of jobs failed',
    labelNames: ['handler'],
    registers: [registry],
  }),

  executionDuration: new Histogram({
    name: 'job_scheduler_execution_duration_seconds',
    help: 'Job execution duration in seconds',
    labelNames: ['handler'],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    registers: [registry],
  }),

  queueDepth: new Gauge({
    name: 'job_scheduler_queue_depth',
    help: 'Current queue depth',
    registers: [registry],
  }),

  circuitBreakerState: new Gauge({
    name: 'job_scheduler_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
    labelNames: ['handler'],
    registers: [registry],
  }),

  schedulerIsLeader: new Gauge({
    name: 'job_scheduler_scheduler_is_leader',
    help: 'Whether this instance is the scheduler leader',
    registers: [registry],
  }),
};

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
```

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
