/**
 * Worker service for the job scheduler system.
 * Polls the queue for pending executions and processes them using registered handlers.
 * Supports concurrent job processing, retry logic, circuit breakers, and graceful shutdown.
 * @module worker
 */

import dotenv from 'dotenv';
dotenv.config();

import { queue } from '../queue/reliable-queue';
import { distributedLock } from '../queue/leader-election';
import * as db from '../db/repository';
import { logger, createChildLogger } from '../utils/logger';
import { ExecutionStatus, JobStatus } from '../types';
import { getHandler, ExecutionContext } from './handlers';
import { migrate } from '../db/migrate';

// Import shared modules
import {
  jobsExecutedTotal,
  jobsCompletedTotal,
  jobsFailedTotal,
  jobExecutionDuration,
  deadLetterTotal,
  workerActiveJobs,
  updateQueueMetrics,
} from '../shared/metrics';
import {
  withCircuitBreaker,
  CircuitBreakerOpenError,
  getCircuitBreakerStates,
} from '../shared/circuit-breaker';
import { markExecutionStarted, clearExecutionIdempotency } from '../shared/idempotency';

/** Unique worker ID for this instance */
const WORKER_ID = process.env.WORKER_ID || `worker-${Date.now()}`;
/** Maximum number of jobs to process concurrently */
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '5', 10);
/** How often to poll the queue in milliseconds */
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '100', 10);
/** Whether to use circuit breakers for job handlers */
const USE_CIRCUIT_BREAKER = process.env.USE_CIRCUIT_BREAKER !== 'false';

/** Worker-specific logger */
const workerLogger = createChildLogger({ workerId: WORKER_ID });

/**
 * Worker class that processes job executions.
 * Continuously polls the queue and runs jobs using their registered handlers.
 * Tracks statistics and maintains heartbeat for monitoring.
 */
class Worker {
  private running: boolean = false;
  private activeJobs: number = 0;
  private jobsCompleted: number = 0;
  private jobsFailed: number = 0;
  private wrappedHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

  /**
   * Starts the worker service.
   * Runs migrations, registers the worker in Redis, and begins the poll loop.
   */
  async start(): Promise<void> {
    workerLogger.info({
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      pollInterval: POLL_INTERVAL_MS,
      useCircuitBreaker: USE_CIRCUIT_BREAKER,
    }, `Starting worker: ${WORKER_ID}`);

    this.running = true;

    // Run migrations first
    await migrate();

    // Register heartbeat
    await this.registerWorker();

    // Start metrics update loop
    this.startMetricsLoop();

    // Start the main processing loop
    this.runLoop();

    workerLogger.info('Worker started');
  }

  /**
   * Stops the worker service gracefully.
   * Waits for active jobs to complete before exiting.
   */
  async stop(): Promise<void> {
    workerLogger.info('Stopping worker...');
    this.running = false;

    // Wait for active jobs to complete (with timeout)
    const timeout = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.activeJobs > 0 && Date.now() - startTime < timeout) {
      workerLogger.info({ activeJobs: this.activeJobs }, `Waiting for ${this.activeJobs} active jobs to complete...`);
      await this.sleep(1000);
    }

    if (this.activeJobs > 0) {
      workerLogger.warn({ activeJobs: this.activeJobs }, `Stopping with ${this.activeJobs} active jobs still running`);
    }

    await this.unregisterWorker();
    workerLogger.info({
      completed: this.jobsCompleted,
      failed: this.jobsFailed,
    }, 'Worker stopped');
  }

  /**
   * Main poll loop that dequeues and processes jobs.
   * Respects concurrency limits and handles errors gracefully.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        // Check if we can take more jobs
        if (this.activeJobs >= MAX_CONCURRENT_JOBS) {
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Try to dequeue a job
        const queueItem = await queue.dequeue(WORKER_ID);

        if (!queueItem) {
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Process the job asynchronously
        this.processJob(queueItem.execution_id, queueItem.job_id).catch((error) => {
          workerLogger.error({ err: error }, 'Unhandled error in job processing');
        });
      } catch (error) {
        workerLogger.error({ err: error }, 'Error in worker loop');
        await this.sleep(1000);
      }
    }
  }

  /**
   * Processes a single job execution.
   * Acquires locks, runs the handler (with circuit breaker), and updates status on completion.
   * @param executionId - UUID of the execution to process
   * @param jobId - UUID of the associated job
   */
  private async processJob(executionId: string, jobId: string): Promise<void> {
    this.activeJobs++;
    workerActiveJobs.set({ worker_id: WORKER_ID }, this.activeJobs);

    const startTime = Date.now();
    let handlerName = 'unknown';

    try {
      // Get execution and job details
      const execution = await db.getExecution(executionId);
      if (!execution) {
        workerLogger.error({ executionId }, `Execution not found: ${executionId}`);
        await queue.complete(executionId, WORKER_ID);
        return;
      }

      const job = await db.getJob(jobId);
      if (!job) {
        workerLogger.error({ jobId }, `Job not found: ${jobId}`);
        await queue.complete(executionId, WORKER_ID);
        return;
      }

      handlerName = job.handler;

      // Check for idempotency - prevent duplicate execution
      const canExecute = await markExecutionStarted(
        jobId,
        executionId,
        execution.scheduled_at,
        job.timeout_ms / 1000 + 60 // TTL: timeout + 1 minute buffer
      );

      if (!canExecute) {
        workerLogger.info({ jobId, executionId }, 'Execution already in progress (idempotency check)');
        await db.updateExecution(executionId, {
          status: ExecutionStatus.DEDUPLICATED,
        });
        await queue.complete(executionId, WORKER_ID);
        return;
      }

      // Try to acquire execution lock for deduplication
      const lockAcquired = await distributedLock.acquire(jobId, executionId);
      if (!lockAcquired) {
        // Another execution is already running
        const currentHolder = await distributedLock.getHolder(jobId);
        if (currentHolder !== executionId) {
          workerLogger.info({ jobId, executionId, currentHolder }, `Job ${jobId} is already being executed, deduplicating`);
          await db.updateExecution(executionId, {
            status: ExecutionStatus.DEDUPLICATED,
          });
          await queue.complete(executionId, WORKER_ID);
          return;
        }
      }

      // Update execution status to running
      await db.updateExecution(executionId, {
        status: ExecutionStatus.RUNNING,
        started_at: new Date(),
        worker_id: WORKER_ID,
      });

      // Update job status
      await db.updateJobStatus(jobId, JobStatus.RUNNING);

      // Update metrics
      jobsExecutedTotal.inc({
        handler: handlerName,
        worker_id: WORKER_ID,
      });

      workerLogger.info({ executionId, jobName: job.name, handler: handlerName }, `Starting execution ${executionId} for job ${job.name}`);

      // Create execution context
      const context: ExecutionContext = {
        log: async (level, message, metadata) => {
          await db.addExecutionLog(executionId, level, message, metadata);
          workerLogger[level]({ ...metadata, jobName: job.name }, `[${job.name}] ${message}`);
        },
        workerId: WORKER_ID,
      };

      // Get the handler
      const handler = getHandler(job.handler);
      if (!handler) {
        throw new Error(`Unknown handler: ${job.handler}`);
      }

      // Wrap handler with circuit breaker if enabled
      let wrappedHandler = handler;
      if (USE_CIRCUIT_BREAKER) {
        if (!this.wrappedHandlers.has(job.handler)) {
          const wrapped = withCircuitBreaker(
            job.handler,
            handler as (...args: unknown[]) => Promise<unknown>,
            {
              timeout: job.timeout_ms,
              errorThresholdPercentage: 50,
              resetTimeout: 30000,
              volumeThreshold: 5,
            }
          );
          this.wrappedHandlers.set(job.handler, wrapped);
        }
        wrappedHandler = this.wrappedHandlers.get(job.handler) as typeof handler;
      }

      // Execute with timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Job execution timed out')), job.timeout_ms);
      });

      const result = await Promise.race([
        wrappedHandler(job, execution, context),
        timeoutPromise,
      ]);

      // Success!
      const duration = (Date.now() - startTime) / 1000;

      await db.updateExecution(executionId, {
        status: ExecutionStatus.COMPLETED,
        completed_at: new Date(),
        result: result as Record<string, unknown>,
      });

      // Update job status for one-time jobs
      if (!job.schedule) {
        await db.updateJobStatus(jobId, JobStatus.COMPLETED);
      } else {
        await db.updateJobStatus(jobId, JobStatus.SCHEDULED);
      }

      await queue.complete(executionId, WORKER_ID);
      await distributedLock.release(jobId, executionId);
      await clearExecutionIdempotency(jobId, execution.scheduled_at);

      // Update metrics
      this.jobsCompleted++;
      jobsCompletedTotal.inc({
        handler: handlerName,
        worker_id: WORKER_ID,
      });
      jobExecutionDuration.observe(
        { handler: handlerName, status: 'success' },
        duration
      );

      workerLogger.info({
        executionId,
        jobName: job.name,
        duration,
      }, `Completed execution ${executionId} for job ${job.name}`);
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;

      // Handle circuit breaker open error specially
      if (error instanceof CircuitBreakerOpenError) {
        workerLogger.warn({
          executionId,
          handler: handlerName,
        }, `Circuit breaker open for handler ${handlerName}, requeueing`);

        // Requeue for later retry
        const job = await db.getJob(jobId);
        if (job) {
          await queue.requeue(executionId, jobId, WORKER_ID, job.priority);
        }
        return;
      }

      await this.handleFailure(executionId, jobId, error as Error, handlerName, duration);
    } finally {
      this.activeJobs--;
      workerActiveJobs.set({ worker_id: WORKER_ID }, this.activeJobs);
      await this.updateHeartbeat();
    }
  }

  /**
   * Handles job execution failure.
   * Implements exponential backoff retry logic or moves to dead letter queue.
   * @param executionId - UUID of the failed execution
   * @param jobId - UUID of the associated job
   * @param error - The error that caused the failure
   * @param handlerName - Name of the handler for metrics
   * @param duration - Execution duration in seconds
   */
  private async handleFailure(
    executionId: string,
    jobId: string,
    error: Error,
    handlerName: string,
    duration: number
  ): Promise<void> {
    workerLogger.error({ err: error, executionId }, `Execution ${executionId} failed`);

    const execution = await db.getExecution(executionId);
    const job = await db.getJob(jobId);

    if (!execution || !job) {
      await queue.complete(executionId, WORKER_ID);
      return;
    }

    // Update metrics
    jobExecutionDuration.observe(
      { handler: handlerName, status: 'failure' },
      duration
    );

    if (execution.attempt < job.max_retries) {
      // Calculate exponential backoff
      const backoffMs = Math.min(
        job.initial_backoff_ms * Math.pow(2, execution.attempt - 1),
        job.max_backoff_ms
      );

      const nextRetryAt = new Date(Date.now() + backoffMs);

      await db.updateExecution(executionId, {
        status: ExecutionStatus.PENDING_RETRY,
        next_retry_at: nextRetryAt,
        error: error.message,
      });

      await db.updateJobStatus(jobId, JobStatus.SCHEDULED);
      await db.addExecutionLog(executionId, 'warn', `Retry scheduled in ${backoffMs}ms`, {
        attempt: execution.attempt,
        maxRetries: job.max_retries,
        nextRetryAt: nextRetryAt.toISOString(),
      });

      // Update metrics
      jobsFailedTotal.inc({
        handler: handlerName,
        worker_id: WORKER_ID,
        retried: 'true',
      });

      workerLogger.info({ executionId, backoffMs }, `Scheduled retry for execution ${executionId} in ${backoffMs}ms`);
    } else {
      // Max retries exceeded
      await db.updateExecution(executionId, {
        status: ExecutionStatus.FAILED,
        completed_at: new Date(),
        error: error.message,
      });

      await db.updateJobStatus(jobId, job.schedule ? JobStatus.SCHEDULED : JobStatus.FAILED);
      await queue.sendToDeadLetter(executionId, WORKER_ID, error.message);

      await db.addExecutionLog(executionId, 'error', 'Max retries exceeded, moving to dead letter queue', {
        attempts: execution.attempt,
        maxRetries: job.max_retries,
      });

      // Update metrics
      this.jobsFailed++;
      jobsFailedTotal.inc({
        handler: handlerName,
        worker_id: WORKER_ID,
        retried: 'false',
      });
      deadLetterTotal.inc({ handler: handlerName });

      workerLogger.error({
        executionId,
        attempts: execution.attempt,
      }, `Execution ${executionId} failed permanently after ${execution.attempt} attempts`);
    }

    await queue.complete(executionId, WORKER_ID);
    await distributedLock.release(jobId, executionId);
    await clearExecutionIdempotency(jobId, execution.scheduled_at);
  }

  /**
   * Starts a loop to periodically update queue metrics.
   */
  private startMetricsLoop(): void {
    setInterval(async () => {
      try {
        const stats = await queue.getStats();
        await updateQueueMetrics(stats);
      } catch (error) {
        workerLogger.error({ err: error }, 'Error updating queue metrics');
      }
    }, 10000); // Every 10 seconds
  }

  /**
   * Registers this worker in Redis for monitoring.
   * Called on startup to make the worker visible to the dashboard.
   */
  private async registerWorker(): Promise<void> {
    // Store worker info in Redis for monitoring
    const { redis } = await import('../queue/redis');
    await redis.hset(
      'job_scheduler:workers',
      WORKER_ID,
      JSON.stringify({
        id: WORKER_ID,
        status: 'active',
        started_at: new Date().toISOString(),
        jobs_completed: this.jobsCompleted,
        jobs_failed: this.jobsFailed,
        last_heartbeat: new Date().toISOString(),
        circuit_breakers: Object.fromEntries(getCircuitBreakerStates()),
      })
    );
  }

  /**
   * Removes this worker from Redis on shutdown.
   */
  private async unregisterWorker(): Promise<void> {
    const { redis } = await import('../queue/redis');
    await redis.hdel('job_scheduler:workers', WORKER_ID);
  }

  /**
   * Updates the worker's heartbeat in Redis.
   * Called after each job to update stats and last seen time.
   */
  private async updateHeartbeat(): Promise<void> {
    const { redis } = await import('../queue/redis');
    await redis.hset(
      'job_scheduler:workers',
      WORKER_ID,
      JSON.stringify({
        id: WORKER_ID,
        status: this.activeJobs > 0 ? 'busy' : 'idle',
        active_jobs: this.activeJobs,
        jobs_completed: this.jobsCompleted,
        jobs_failed: this.jobsFailed,
        last_heartbeat: new Date().toISOString(),
        circuit_breakers: Object.fromEntries(getCircuitBreakerStates()),
      })
    );
  }

  /** Helper function for async delays */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns current worker statistics.
   * @returns Object with worker ID, running state, and job counts
   */
  getStats() {
    return {
      workerId: WORKER_ID,
      running: this.running,
      activeJobs: this.activeJobs,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      circuitBreakers: Object.fromEntries(getCircuitBreakerStates()),
    };
  }
}

/** Singleton worker instance */
const worker = new Worker();

/**
 * Graceful shutdown handlers.
 * Ensures the worker completes active jobs before exiting.
 */
// Graceful shutdown
process.on('SIGTERM', async () => {
  workerLogger.info('Received SIGTERM, shutting down...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  workerLogger.info('Received SIGINT, shutting down...');
  await worker.stop();
  process.exit(0);
});

// Start the worker
worker.start().catch((error) => {
  workerLogger.error({ err: error }, 'Failed to start worker');
  process.exit(1);
});

export { worker };
