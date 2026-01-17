import dotenv from 'dotenv';
dotenv.config();

import { LeaderElection } from '../queue/leader-election';
import { queue } from '../queue/reliable-queue';
import * as db from '../db/repository';
import { logger } from '../utils/logger';
import { JobStatus } from '../types';
import { migrate } from '../db/migrate';

const INSTANCE_ID = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${Date.now()}`;
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '1000', 10);
const LEADER_LOCK_TTL = parseInt(process.env.LEADER_LOCK_TTL || '30', 10);
const STALE_RECOVERY_INTERVAL_MS = 60000; // 1 minute

class Scheduler {
  private leaderElection: LeaderElection;
  private running: boolean = false;
  private scanLoopHandle: NodeJS.Timeout | null = null;
  private recoveryLoopHandle: NodeJS.Timeout | null = null;
  private retryLoopHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.leaderElection = new LeaderElection(
      INSTANCE_ID,
      'job_scheduler:scheduler:leader',
      LEADER_LOCK_TTL
    );
  }

  async start(): Promise<void> {
    logger.info(`Starting scheduler instance: ${INSTANCE_ID}`);
    this.running = true;

    // Run migrations first
    await migrate();

    // Start the main scheduling loop
    this.runScanLoop();

    // Start the stale job recovery loop
    this.runRecoveryLoop();

    // Start the retry scheduling loop
    this.runRetryLoop();

    logger.info('Scheduler started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping scheduler...');
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

    await this.leaderElection.releaseLeadership();
    logger.info('Scheduler stopped');
  }

  private async runScanLoop(): Promise<void> {
    while (this.running) {
      try {
        // Try to become or maintain leadership
        if (!this.leaderElection.getIsLeader()) {
          const acquired = await this.leaderElection.tryBecomeLeader();
          if (!acquired) {
            await this.sleep(SCAN_INTERVAL_MS);
            continue;
          }
        }

        // Only the leader scans for due jobs
        await this.scanDueJobs();
      } catch (error) {
        logger.error('Error in scheduler scan loop', error);
      }

      await this.sleep(SCAN_INTERVAL_MS);
    }
  }

  private async scanDueJobs(): Promise<void> {
    const dueJobs = await db.getDueJobs(100);

    if (dueJobs.length === 0) {
      return;
    }

    logger.info(`Found ${dueJobs.length} due jobs`);

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

        logger.info(`Scheduled execution ${execution.id} for job ${job.name}`);
      } catch (error) {
        logger.error(`Error scheduling job ${job.id}`, error);
      }
    }
  }

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
              logger.warn(`Re-enqueued stalled execution ${executionId}`);
            }
          }
        }

        if (recoveredIds.length > 0) {
          logger.info(`Recovered ${recoveredIds.length} stalled executions`);
        }
      } catch (error) {
        logger.error('Error in recovery loop', error);
      }
    }, STALE_RECOVERY_INTERVAL_MS);
  }

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
            status: 'FAILED' as const,
          });

          // Enqueue the retry
          await queue.enqueue(newExecution.id, job.id, job.priority);

          logger.info(`Scheduled retry for job ${job.name}, attempt ${newExecution.attempt}`);
        }
      } catch (error) {
        logger.error('Error in retry loop', error);
      }
    }, 5000); // Check every 5 seconds
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isLeader(): boolean {
    return this.leaderElection.getIsLeader();
  }

  getInstanceId(): string {
    return INSTANCE_ID;
  }
}

const scheduler = new Scheduler();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await scheduler.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await scheduler.stop();
  process.exit(0);
});

// Start the scheduler
scheduler.start().catch((error) => {
  logger.error('Failed to start scheduler', error);
  process.exit(1);
});

export { scheduler };
