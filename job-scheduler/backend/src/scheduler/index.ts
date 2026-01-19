/**
 * Scheduler service for the job scheduler system.
 * Scans for due jobs, creates executions, and enqueues them for worker processing.
 * Uses leader election to ensure only one scheduler is active at a time.
 * @module scheduler
 */

import dotenv from 'dotenv';
dotenv.config();

import { LeaderElection } from '../queue/leader-election';
import { queue } from '../queue/reliable-queue';
import * as db from '../db/repository.js';
import { _logger, createChildLogger } from '../utils/logger';
import { JobStatus, ExecutionStatus } from '../types';
import { migrate } from '../db/migrate';

// Import shared modules
import {
  schedulerIsLeader,
  stalledJobsRecovered,
  jobsScheduledTotal,
  updateQueueMetrics,
} from '../shared/metrics';

/** Unique instance ID for this scheduler, used in leader election */
const INSTANCE_ID = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${Date.now()}`;
/** How often to scan for due jobs in milliseconds */
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '1000', 10);
/** Leader lock TTL in seconds */
const LEADER_LOCK_TTL = parseInt(process.env.LEADER_LOCK_TTL || '30', 10);
/** How often to check for stalled jobs in milliseconds */
const STALE_RECOVERY_INTERVAL_MS = 60000; // 1 minute

/** Scheduler-specific logger */
const schedulerLogger = createChildLogger({ instanceId: INSTANCE_ID });

/**
 * Main scheduler class that coordinates job scheduling.
 * Runs three loops: scan for due jobs, recover stalled executions, and process retries.
 * Only the leader instance actively schedules; others wait for failover.
 */
class Scheduler {
  private leaderElection: LeaderElection;
  private running: boolean = false;
  private scanLoopHandle: NodeJS.Timeout | null = null;
  private recoveryLoopHandle: NodeJS.Timeout | null = null;
  private retryLoopHandle: NodeJS.Timeout | null = null;
  private metricsLoopHandle: NodeJS.Timeout | null = null;

  /** Initializes the scheduler with leader election configuration */
  constructor() {
    this.leaderElection = new LeaderElection(
      INSTANCE_ID,
      'job_scheduler:scheduler:leader',
      LEADER_LOCK_TTL
    );
  }

  /**
   * Starts the scheduler service.
   * Runs migrations, then starts the scan, recovery, and retry loops.
   */
  async start(): Promise<void> {
    schedulerLogger.info({
      scanInterval: SCAN_INTERVAL_MS,
      leaderLockTTL: LEADER_LOCK_TTL,
    }, `Starting scheduler instance: ${INSTANCE_ID}`);
    this.running = true;

    // Run migrations first
    await migrate();

    // Start the main scheduling loop
    this.runScanLoop();

    // Start the stale job recovery loop
    this.runRecoveryLoop();

    // Start the retry scheduling loop
    this.runRetryLoop();

    // Start metrics update loop
    this.startMetricsLoop();

    schedulerLogger.info('Scheduler started');
  }

  /**
   * Stops the scheduler service gracefully.
   * Clears all loop timers and releases leadership.
   */
  async stop(): Promise<void> {
    schedulerLogger.info('Stopping scheduler...');
    this.running = false;

    if (this.scanLoopHandle) {
      clearTimeout(this.scanLoopHandle);
      this.scanLoopHandle = null;
    }

    if (this.recoveryLoopHandle) {
      clearInterval(this.recoveryLoopHandle);
      this.recoveryLoopHandle = null;
    }

    if (this.retryLoopHandle) {
      clearInterval(this.retryLoopHandle);
      this.retryLoopHandle = null;
    }

    if (this.metricsLoopHandle) {
      clearInterval(this.metricsLoopHandle);
      this.metricsLoopHandle = null;
    }

    await this.leaderElection.releaseLeadership();

    // Update leader metric
    schedulerIsLeader.set({ instance_id: INSTANCE_ID }, 0);

    schedulerLogger.info('Scheduler stopped');
  }

  /**
   * Main scheduling loop that scans for due jobs.
   * Tries to acquire leadership, then processes due jobs if leader.
   */
  private async runScanLoop(): Promise<void> {
    while (this.running) {
      try {
        // Try to become or maintain leadership
        const wasLeader = this.leaderElection.getIsLeader();
        if (!wasLeader) {
          const acquired = await this.leaderElection.tryBecomeLeader();
          if (acquired) {
            schedulerLogger.info('Became leader');
            schedulerIsLeader.set({ instance_id: INSTANCE_ID }, 1);
          } else {
            schedulerIsLeader.set({ instance_id: INSTANCE_ID }, 0);
            await this.sleep(SCAN_INTERVAL_MS);
            continue;
          }
        }

        // Only the leader scans for due jobs
        await this.scanDueJobs();
      } catch (error) {
        schedulerLogger.error({ err: error }, 'Error in scheduler scan loop');
      }

      await this.sleep(SCAN_INTERVAL_MS);
    }
  }

  /**
   * Scans for jobs that are due to run and enqueues them.
   * Creates execution records and updates job status.
   */
  private async scanDueJobs(): Promise<void> {
    const dueJobs = await db.getDueJobs(100);

    if (dueJobs.length === 0) {
      return;
    }

    schedulerLogger.info({ count: dueJobs.length }, `Found ${dueJobs.length} due jobs`);

    for (const job of dueJobs) {
      try {
        // Create execution record
        const execution = await db.createExecution(
          job.id,
          job.next_run_time || new Date()
        );

        // Enqueue for worker processing
        await queue.enqueue(execution.id, job.id, job.priority);

        // Update job status to queued
        await db.updateJobStatus(job.id, JobStatus.QUEUED);

        // Schedule next run for recurring jobs
        if (job.schedule) {
          await db.scheduleNextRun(job.id);
        }

        // Update metrics
        jobsScheduledTotal.inc({
          handler: job.handler,
          priority: job.priority.toString(),
        });

        schedulerLogger.info({
          executionId: execution.id,
          jobId: job.id,
          jobName: job.name,
        }, `Scheduled execution ${execution.id} for job ${job.name}`);
      } catch (error) {
        schedulerLogger.error({ err: error, jobId: job.id }, `Error scheduling job ${job.id}`);
      }
    }
  }

  /**
   * Recovery loop that finds and re-enqueues stalled executions.
   * Runs periodically to handle worker crashes or timeouts.
   */
  private runRecoveryLoop(): void {
    this.recoveryLoopHandle = setInterval(async () => {
      if (!this.running || !this.leaderElection.getIsLeader()) {
        return;
      }

      try {
        const recoveredIds = await queue.recoverStalled();

        for (const executionId of recoveredIds) {
          const execution = await db.getExecution(executionId);
          if (execution) {
            const job = await db.getJob(execution.job_id);
            if (job) {
              // Re-enqueue the recovered job
              await queue.enqueue(executionId, job.id, job.priority);
              stalledJobsRecovered.inc();
              schedulerLogger.warn({ executionId, jobId: job.id }, `Re-enqueued stalled execution ${executionId}`);
            }
          }
        }

        if (recoveredIds.length > 0) {
          schedulerLogger.info({ count: recoveredIds.length }, `Recovered ${recoveredIds.length} stalled executions`);
        }
      } catch (error) {
        schedulerLogger.error({ err: error }, 'Error in recovery loop');
      }
    }, STALE_RECOVERY_INTERVAL_MS);
  }

  /**
   * Retry loop that schedules pending retries.
   * Checks for executions ready for retry and enqueues them.
   */
  private runRetryLoop(): void {
    this.retryLoopHandle = setInterval(async () => {
      if (!this.running || !this.leaderElection.getIsLeader()) {
        return;
      }

      try {
        const retryableExecutions = await db.getRetryableExecutions(50);

        for (const execution of retryableExecutions) {
          const job = await db.getJob(execution.job_id);
          if (!job) {
            continue;
          }

          // Create a new execution for the retry
          const newExecution = await db.createExecution(
            job.id,
            new Date(),
            execution.attempt + 1
          );

          // Update the old execution to mark it as superseded
          await db.updateExecution(execution.id, {
            status: ExecutionStatus.FAILED,
          });

          // Enqueue the retry
          await queue.enqueue(newExecution.id, job.id, job.priority);

          schedulerLogger.info({
            jobName: job.name,
            attempt: newExecution.attempt,
            oldExecutionId: execution.id,
            newExecutionId: newExecution.id,
          }, `Scheduled retry for job ${job.name}, attempt ${newExecution.attempt}`);
        }
      } catch (error) {
        schedulerLogger.error({ err: error }, 'Error in retry loop');
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Starts a loop to periodically update queue metrics.
   */
  private startMetricsLoop(): void {
    this.metricsLoopHandle = setInterval(async () => {
      try {
        const stats = await queue.getStats();
        await updateQueueMetrics(stats);
      } catch (error) {
        schedulerLogger.error({ err: error }, 'Error updating queue metrics');
      }
    }, 10000); // Every 10 seconds
  }

  /**
   * Helper function for async delays.
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Checks if this scheduler instance is the current leader.
   * @returns True if this instance holds the leader lock
   */
  isLeader(): boolean {
    return this.leaderElection.getIsLeader();
  }

  /**
   * Gets this scheduler's unique instance identifier.
   * @returns The instance ID string
   */
  getInstanceId(): string {
    return INSTANCE_ID;
  }
}

/** Singleton scheduler instance */
const scheduler = new Scheduler();

/**
 * Graceful shutdown handlers for SIGTERM and SIGINT signals.
 * Ensures the scheduler releases leadership before exiting.
 */
// Graceful shutdown
process.on('SIGTERM', async () => {
  schedulerLogger.info('Received SIGTERM, shutting down...');
  await scheduler.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  schedulerLogger.info('Received SIGINT, shutting down...');
  await scheduler.stop();
  process.exit(0);
});

// Start the scheduler
scheduler.start().catch((error) => {
  schedulerLogger.error({ err: error }, 'Failed to start scheduler');
  process.exit(1);
});

export { scheduler };
