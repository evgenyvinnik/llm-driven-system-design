/**
 * Worker service for the job scheduler system.
 *
 * Claims executions from PostgreSQL (FOR UPDATE SKIP LOCKED), runs each under a lease
 * that it renews while the handler works, and records the outcome with writes fenced
 * on the lease's token. If the lease cannot be renewed in time the attempt is stopped,
 * because the reaper may already have handed the run to another worker.
 * @module worker
 */

import dotenv from 'dotenv';
dotenv.config();

import { performance } from 'perf_hooks';
import { redis, disconnect as disconnectRedis } from '../queue/redis';
import { pool } from '../db/pool';
import * as db from '../db/repository';
import { createChildLogger } from '../utils/logger';
import { Job } from '../types';
import { getHandler, ExecutionContext, NonRetryableError } from './handlers';
// Registers the system.maintenance handler. The API process already loads it (via the
// admin routes); without this import workers rejected those jobs as an unknown handler.
import '../shared/archival';
import { migrate } from '../db/migrate';

// Import shared modules
import {
  jobsExecutedTotal,
  jobsCompletedTotal,
  jobsFailedTotal,
  jobExecutionDuration,
  deadLetterTotal,
  workerActiveJobs,
  fencedWritesRejected,
  startMetricsServer,
} from '../shared/metrics';
import {
  withCircuitBreaker,
  CircuitBreakerOpenError,
  getCircuitBreakerStates,
} from '../shared/circuit-breaker';

/** Unique worker ID for this instance */
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
/** Maximum number of executions held at once */
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '5', 10);
/** How long to wait before claiming again when nothing was runnable */
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
/** Lease length; a worker that stops renewing loses the execution after this long */
const LEASE_DURATION_MS = parseInt(process.env.LEASE_DURATION_MS || '30000', 10);
/** How often held leases are renewed (three renewals per lease by default) */
const LEASE_RENEW_INTERVAL_MS = parseInt(
  process.env.LEASE_RENEW_INTERVAL_MS || String(Math.floor(LEASE_DURATION_MS / 3)),
  10
);
/** Stop an attempt this long before its lease would lapse when renewals keep failing */
const LEASE_SAFETY_MARGIN_MS = Math.min(2000, Math.floor(LEASE_DURATION_MS / 10));
/** How often the worker refreshes its entry in the liveness registry */
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '5000', 10);
/** How long shutdown waits for running attempts before handing them back */
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10);
/** How long an execution is held back when its handler's circuit is open */
const BREAKER_HOLD_MS = 30000;
/** Whether to use circuit breakers for job handlers */
const USE_CIRCUIT_BREAKER = process.env.USE_CIRCUIT_BREAKER !== 'false';
/** Redis hash holding one liveness entry per worker */
const WORKER_REGISTRY_KEY = 'job_scheduler:workers';

/** Worker-specific logger */
const workerLogger = createChildLogger({ workerId: WORKER_ID });

/** Why an attempt's AbortSignal fired; decides which outcome (if any) this worker writes. */
type StopReason = 'timeout' | 'lease_lost' | 'lease_unconfirmed' | 'shutdown';

/** Abort reason carried by an attempt's AbortSignal. */
class AttemptStopped extends Error {
  constructor(readonly reason: StopReason, message: string) {
    super(message);
    this.name = 'AttemptStopped';
  }
}

/** One execution this worker currently holds a lease on. */
interface ActiveAttempt {
  lease: db.LeaseRef;
  controller: AbortController;
  /** Fires when the lease would lapse without a confirmed renewal (self-fencing). */
  fenceTimer?: NodeJS.Timeout;
}

type HandlerFn = NonNullable<ReturnType<typeof getHandler>>;

/**
 * Settles with the handler's result, or rejects with the abort reason as soon as the
 * signal fires, so a handler that ignores its signal cannot hold the slot forever.
 */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Claims and runs executions with bounded concurrency.
 */
class Worker {
  private running: boolean = false;
  private active = new Map<string, ActiveAttempt>();
  private inFlight = new Set<Promise<void>>();
  private jobsCompleted: number = 0;
  private jobsFailed: number = 0;
  private wrappedHandlers = new Map<string, HandlerFn>();
  private loopPromise: Promise<void> | null = null;
  private renewHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private renewing: boolean = false;
  private readonly startedAt = new Date().toISOString();

  /**
   * Starts the worker service: migrations, liveness heartbeat, lease renewal, claim loop.
   */
  async start(): Promise<void> {
    workerLogger.info({
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      pollInterval: POLL_INTERVAL_MS,
      leaseDurationMs: LEASE_DURATION_MS,
      leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS,
      useCircuitBreaker: USE_CIRCUIT_BREAKER,
    }, `Starting worker: ${WORKER_ID}`);

    this.running = true;

    await migrate();

    await this.heartbeat();
    this.heartbeatHandle = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.renewHandle = setInterval(() => void this.renewLeases(), LEASE_RENEW_INTERVAL_MS);
    startMetricsServer(parseInt(process.env.METRICS_PORT || '', 10));
    this.loopPromise = this.runLoop();

    workerLogger.info('Worker started');
  }

  /**
   * Stops gracefully: stop claiming, give running attempts SHUTDOWN_GRACE_MS to finish,
   * then abort the rest and hand them back to the queue (fenced release), so another
   * worker picks them up now rather than after their lease lapses.
   */
  async stop(): Promise<void> {
    workerLogger.info('Stopping worker...');
    this.running = false;
    await this.loopPromise;

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.active.size > 0 && Date.now() < deadline) {
      workerLogger.info({ activeJobs: this.active.size }, 'Waiting for running executions to finish...');
      await this.sleep(500);
    }

    for (const attempt of this.active.values()) {
      attempt.controller.abort(new AttemptStopped('shutdown', 'Worker shutting down'));
    }
    await Promise.allSettled([...this.inFlight]);

    if (this.renewHandle) clearInterval(this.renewHandle);
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);

    try {
      await redis.hdel(WORKER_REGISTRY_KEY, WORKER_ID);
    } catch (error) {
      workerLogger.error({ err: error }, 'Failed to remove worker from registry');
    }

    workerLogger.info({
      completed: this.jobsCompleted,
      failed: this.jobsFailed,
    }, 'Worker stopped');
  }

  /**
   * Claim loop: claim as many executions as there are free slots, start them, repeat.
   * Sleeps (with jitter, so idle workers don't poll in lockstep) only when nothing was
   * runnable or every slot is busy.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const free = MAX_CONCURRENT_JOBS - this.active.size;
        if (free <= 0) {
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }

        const sentAt = performance.now();
        const claimed = await db.claimExecutions(WORKER_ID, free, LEASE_DURATION_MS);
        if (claimed.length === 0) {
          await this.sleep(POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_INTERVAL_MS * 0.2));
          continue;
        }

        for (const execution of claimed) {
          const work = this.processExecution(execution, sentAt).catch((error) => {
            workerLogger.error({ err: error, executionId: execution.id }, 'Unhandled error in execution processing');
          });
          this.inFlight.add(work);
          void work.finally(() => this.inFlight.delete(work));
        }
      } catch (error) {
        workerLogger.error({ err: error }, 'Error in worker loop');
        await this.sleep(1000);
      }
    }
  }

  /**
   * Runs one claimed execution and records its outcome.
   * @param claimSentAt - monotonic time the claim was sent; the lease started no earlier
   */
  private async processExecution(execution: db.ClaimedExecution, claimSentAt: number): Promise<void> {
    const lease: db.LeaseRef = { executionId: execution.id, fencingToken: execution.fencing_token };
    const attempt: ActiveAttempt = { lease, controller: new AbortController() };
    this.active.set(execution.id, attempt);
    this.armFence(attempt, claimSentAt);
    this.reportActive();

    const startTime = Date.now();
    let handlerName = 'unknown';
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const job = await db.getJob(execution.job_id);
      if (!job) {
        // Deleted after the claim; ON DELETE CASCADE removed the execution too.
        return;
      }
      handlerName = job.handler;

      jobsExecutedTotal.inc({ handler: handlerName, worker_id: WORKER_ID });
      workerLogger.info({
        executionId: execution.id,
        jobName: job.name,
        handler: handlerName,
        attempt: execution.attempt,
        fencingToken: lease.fencingToken,
      }, `Starting execution ${execution.id} for job ${job.name}`);

      timeoutHandle = setTimeout(() => {
        attempt.controller.abort(new AttemptStopped('timeout', `Job execution timed out after ${job.timeout_ms}ms`));
      }, job.timeout_ms);

      const context: ExecutionContext = {
        log: async (level, message, metadata) => {
          await db.addExecutionLog(execution.id, level, message, metadata);
          workerLogger[level]({ ...metadata, jobName: job.name }, `[${job.name}] ${message}`);
        },
        workerId: WORKER_ID,
        signal: attempt.controller.signal,
        fencingToken: lease.fencingToken,
        idempotencyKey: `${job.id}:${new Date(execution.scheduled_at).toISOString()}`,
      };

      const handler = this.resolveHandler(job);
      const result = await raceWithAbort(handler(job, execution, context), attempt.controller.signal);

      const recorded = await db.completeExecution(lease, result);
      if (!recorded) {
        fencedWritesRejected.inc({ operation: 'complete' });
        workerLogger.warn({ executionId: execution.id, fencingToken: lease.fencingToken },
          'Result discarded: this worker no longer holds the lease (cancelled or reclaimed)');
        return;
      }

      const duration = (Date.now() - startTime) / 1000;
      this.jobsCompleted++;
      jobsCompletedTotal.inc({ handler: handlerName, worker_id: WORKER_ID });
      jobExecutionDuration.observe({ handler: handlerName, status: 'success' }, duration);
      workerLogger.info({ executionId: execution.id, jobName: job.name, duration },
        `Completed execution ${execution.id} for job ${job.name}`);
    } catch (error) {
      await this.recordFailure(lease, attempt.controller.signal, error, handlerName, startTime);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (attempt.fenceTimer) clearTimeout(attempt.fenceTimer);
      this.active.delete(execution.id);
      this.reportActive();
    }
  }

  /**
   * Writes the outcome of an attempt that did not succeed. The abort reason wins over
   * whatever the handler threw in response to the abort.
   */
  private async recordFailure(
    lease: db.LeaseRef,
    signal: AbortSignal,
    error: unknown,
    handlerName: string,
    startTime: number
  ): Promise<void> {
    const stop = signal.aborted && signal.reason instanceof AttemptStopped ? signal.reason : null;

    try {
      if (stop?.reason === 'lease_lost') {
        // Cancelled or reclaimed: whoever took the row owns its outcome now.
        workerLogger.warn({ executionId: lease.executionId }, 'Stopped: lease lost (cancelled or reclaimed)');
        return;
      }

      if (stop?.reason === 'shutdown' || error instanceof CircuitBreakerOpenError) {
        // The handler did not finish (or never ran): return the execution without
        // consuming an attempt. An open circuit holds it back until the breaker half-opens.
        const delayMs = stop?.reason === 'shutdown' ? 0 : BREAKER_HOLD_MS;
        const released = await db.releaseExecution(lease, delayMs);
        if (!released) fencedWritesRejected.inc({ operation: 'release' });
        workerLogger.warn({ executionId: lease.executionId, handler: handlerName, delayMs },
          stop ? 'Handed execution back to the queue on shutdown' : `Circuit open for ${handlerName}; execution held back`);
        return;
      }

      const message = stop ? stop.message : error instanceof Error ? error.message : String(error);
      const retryable = !(error instanceof NonRetryableError);
      const outcome = await db.failExecution(lease, message, retryable);
      if (!outcome) {
        fencedWritesRejected.inc({ operation: 'fail' });
        workerLogger.warn({ executionId: lease.executionId }, 'Failure not recorded: lease no longer held');
        return;
      }

      jobExecutionDuration.observe({ handler: handlerName, status: 'failure' }, (Date.now() - startTime) / 1000);
      jobsFailedTotal.inc({
        handler: handlerName,
        worker_id: WORKER_ID,
        retried: outcome.outcome === 'retry' ? 'true' : 'false',
      });

      if (outcome.outcome === 'retry') {
        workerLogger.warn({ executionId: lease.executionId, err: message, nextAttempt: outcome.nextAttempt, runAt: outcome.runAt },
          `Execution ${lease.executionId} failed; attempt ${outcome.nextAttempt} scheduled`);
        await db.addExecutionLog(lease.executionId, 'warn', `Failed: ${message}. Retry scheduled`, {
          nextAttempt: outcome.nextAttempt,
          runAt: outcome.runAt.toISOString(),
        });
      } else {
        this.jobsFailed++;
        deadLetterTotal.inc({ handler: handlerName });
        workerLogger.error({ executionId: lease.executionId, err: message, retryable },
          `Execution ${lease.executionId} dead-lettered`);
        await db.addExecutionLog(lease.executionId, 'error',
          retryable ? `Failed: ${message}. No retries left; dead-lettered` : `Failed permanently: ${message}; dead-lettered`);
      }
    } catch (writeError) {
      // The database is unreachable: leave the row RUNNING; the reaper retries it
      // after the lease lapses.
      workerLogger.error({ err: writeError, executionId: lease.executionId }, 'Failed to record execution outcome');
    }
  }

  /**
   * Arms (or re-arms) the self-fencing timer: if no renewal is confirmed before the
   * lease would lapse, abort the attempt. Measured from when the claim or renewal was
   * sent, which is no later than when PostgreSQL set the lease.
   */
  private armFence(attempt: ActiveAttempt, sentAt: number): void {
    if (attempt.fenceTimer) clearTimeout(attempt.fenceTimer);
    const delay = Math.max(0, sentAt + LEASE_DURATION_MS - LEASE_SAFETY_MARGIN_MS - performance.now());
    attempt.fenceTimer = setTimeout(() => {
      attempt.controller.abort(new AttemptStopped('lease_unconfirmed',
        `Lease renewal not confirmed within ${LEASE_DURATION_MS}ms; attempt stopped`));
    }, delay);
  }

  /**
   * Renews every held lease in one query. A lease missing from the result was cancelled
   * or reclaimed, so its handler is aborted. On a database error nothing is renewed and
   * the fence timers stop attempts whose lease can no longer be trusted.
   */
  private async renewLeases(): Promise<void> {
    if (this.renewing || this.active.size === 0) {
      return;
    }

    this.renewing = true;
    const attempts = [...this.active.values()].filter((a) => !a.controller.signal.aborted);
    const sentAt = performance.now();
    try {
      const held = await db.renewLeases(attempts.map((a) => a.lease), LEASE_DURATION_MS);
      for (const attempt of attempts) {
        if (!this.active.has(attempt.lease.executionId)) {
          continue; // finished while the renewal was in flight
        }
        if (held.has(attempt.lease.executionId)) {
          this.armFence(attempt, sentAt);
        } else {
          attempt.controller.abort(new AttemptStopped('lease_lost', 'Lease lost: execution was cancelled or reclaimed'));
        }
      }
    } catch (error) {
      workerLogger.error({ err: error }, 'Lease renewal failed');
    } finally {
      this.renewing = false;
    }
  }

  /**
   * Looks up the handler, wrapped in its circuit breaker. An unknown handler is a
   * permanent failure: retrying cannot make it appear.
   */
  private resolveHandler(job: Job): HandlerFn {
    const handler = getHandler(job.handler);
    if (!handler) {
      throw new NonRetryableError(`Unknown handler: ${job.handler}`);
    }
    if (!USE_CIRCUIT_BREAKER) {
      return handler;
    }

    let wrapped = this.wrappedHandlers.get(job.handler);
    if (!wrapped) {
      wrapped = withCircuitBreaker(job.handler, handler as (...args: unknown[]) => Promise<unknown>, {
        // Each job's timeout_ms is enforced by the worker; a breaker-wide timeout taken
        // from whichever job ran first would be wrong for all the others.
        timeout: false,
        errorThresholdPercentage: 50,
        resetTimeout: BREAKER_HOLD_MS,
        volumeThreshold: 5,
        // Bad payloads and cancelled attempts say nothing about the dependency's health.
        errorFilter: (error) =>
          error instanceof NonRetryableError ||
          (error instanceof AttemptStopped && error.reason !== 'timeout'),
      }) as HandlerFn;
      this.wrappedHandlers.set(job.handler, wrapped);
    }
    return wrapped;
  }

  /** Refreshes this worker's entry in the liveness registry the dashboard reads. */
  private async heartbeat(): Promise<void> {
    try {
      await redis.hset(
        WORKER_REGISTRY_KEY,
        WORKER_ID,
        JSON.stringify({
          id: WORKER_ID,
          status: this.active.size > 0 ? 'busy' : 'idle',
          active_jobs: this.active.size,
          max_concurrency: MAX_CONCURRENT_JOBS,
          jobs_completed: this.jobsCompleted,
          jobs_failed: this.jobsFailed,
          started_at: this.startedAt,
          last_heartbeat: new Date().toISOString(),
          circuit_breakers: Object.fromEntries(getCircuitBreakerStates()),
        })
      );
    } catch (error) {
      workerLogger.error({ err: error }, 'Failed to write worker heartbeat');
    }
  }

  private reportActive(): void {
    workerActiveJobs.set({ worker_id: WORKER_ID }, this.active.size);
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
      activeJobs: this.active.size,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      circuitBreakers: Object.fromEntries(getCircuitBreakerStates()),
    };
  }
}

/** Singleton worker instance */
const worker = new Worker();

/** Graceful shutdown on SIGTERM/SIGINT: drain, hand back the rest, close connections. */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  workerLogger.info(`Received ${signal}, shutting down...`);
  try {
    await worker.stop();
    await pool.end();
    await disconnectRedis();
  } catch (error) {
    workerLogger.error({ err: error }, 'Error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Start the worker
worker.start().catch((error) => {
  workerLogger.error({ err: error }, 'Failed to start worker');
  process.exit(1);
});

export { worker };
