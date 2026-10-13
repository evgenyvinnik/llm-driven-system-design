/**
 * Scheduler service for the job scheduler system.
 *
 * Runs two leader-only loops:
 * - the tick: fire every due job (insert its execution, advance next_run_time) in one
 *   PostgreSQL transaction per batch;
 * - the reaper: reclaim executions whose worker stopped renewing its lease.
 * Every instance also refreshes the queue gauges. Standby instances try to take the
 * leader lease on every tick, so failover takes at most the lease TTL plus one tick.
 * @module scheduler
 */

import dotenv from 'dotenv';
dotenv.config();

import { LeaderElection } from '../queue/leader-election';
import { disconnect as disconnectRedis } from '../queue/redis';
import { pool } from '../db/pool';
import * as db from '../db/repository';
import { createChildLogger } from '../utils/logger';
import { migrate } from '../db/migrate';

// Import shared modules
import {
  schedulerIsLeader,
  stalledJobsRecovered,
  jobsScheduledTotal,
  misfiresTotal,
  updateQueueMetrics,
  startMetricsServer,
} from '../shared/metrics';

/** Unique instance ID for this scheduler, used as the leader lease value */
const INSTANCE_ID = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;
/** How often to look for due jobs, in milliseconds */
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '1000', 10);
/** Leader lease TTL; LEADER_LOCK_TTL is in seconds for backwards compatibility */
const LEADER_LOCK_TTL_MS = parseInt(process.env.LEADER_LOCK_TTL || '30', 10) * 1000;
/** Maximum due jobs fired per transaction */
const SCAN_BATCH_SIZE = parseInt(process.env.SCAN_BATCH_SIZE || '500', 10);
/** Passes per tick when every pass comes back full (catch-up after an outage) */
const MAX_PASSES_PER_TICK = 10;
/**
 * How late a recurring slot may be and still count as on time. It must exceed the
 * worst-case failover (lease TTL + one tick), or every failover produces misfires.
 */
const MISFIRE_GRACE_MS = parseInt(process.env.MISFIRE_GRACE_MS || '60000', 10);
/** How often the leader reclaims executions whose lease lapsed */
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '5000', 10);
/** Maximum leases reclaimed per reaper transaction */
const REAPER_BATCH_SIZE = 100;
/** How often to refresh the queue gauges */
const METRICS_INTERVAL_MS = 10000;

/** Scheduler-specific logger */
const schedulerLogger = createChildLogger({ instanceId: INSTANCE_ID });

/**
 * Coordinates firing and lease recovery. Only the leader does either; the others keep
 * trying to take the lease.
 */
class Scheduler {
  private leaderElection: LeaderElection;
  private running: boolean = false;
  private tickLoop: Promise<void> | null = null;
  private reaperHandle: NodeJS.Timeout | null = null;
  private metricsHandle: NodeJS.Timeout | null = null;
  private reaping: boolean = false;

  /** Initializes the scheduler with leader election configuration */
  constructor() {
    this.leaderElection = new LeaderElection(
      INSTANCE_ID,
      'job_scheduler:scheduler:leader',
      LEADER_LOCK_TTL_MS
    );
  }

  /**
   * Starts the scheduler service.
   * Runs migrations, then starts the tick, reaper, and metrics loops.
   */
  async start(): Promise<void> {
    schedulerLogger.info({
      scanInterval: SCAN_INTERVAL_MS,
      leaderLockTtlMs: LEADER_LOCK_TTL_MS,
      misfireGraceMs: MISFIRE_GRACE_MS,
      reaperInterval: REAPER_INTERVAL_MS,
    }, `Starting scheduler instance: ${INSTANCE_ID}`);
    this.running = true;

    await migrate();

    startMetricsServer(parseInt(process.env.METRICS_PORT || '', 10));
    this.tickLoop = this.runTickLoop();
    this.reaperHandle = setInterval(() => void this.reap(), REAPER_INTERVAL_MS);
    this.metricsHandle = setInterval(() => void this.refreshQueueMetrics(), METRICS_INTERVAL_MS);

    schedulerLogger.info('Scheduler started');
  }

  /**
   * Stops the scheduler service gracefully: finishes the current tick, stops the
   * loops, and releases the lease so a standby can take over immediately.
   */
  async stop(): Promise<void> {
    schedulerLogger.info('Stopping scheduler...');
    this.running = false;

    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    if (this.metricsHandle) {
      clearInterval(this.metricsHandle);
      this.metricsHandle = null;
    }

    await this.tickLoop;
    await this.leaderElection.release();
    schedulerIsLeader.set({ instance_id: INSTANCE_ID }, 0);

    schedulerLogger.info('Scheduler stopped');
  }

  /** Main loop: one tick every SCAN_INTERVAL_MS. */
  private async runTickLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        schedulerLogger.error({ err: error }, 'Error in scheduler tick');
      }
      await this.sleep(SCAN_INTERVAL_MS);
    }
  }

  /**
   * One tick: make sure we lead, then fire due jobs in batches. Leadership is
   * re-checked before every batch, so a leader that loses its lease mid-catch-up
   * stops within one batch.
   */
  private async tick(): Promise<void> {
    if (!this.leaderElection.isLeader()) {
      const acquired = await this.leaderElection.tryAcquire();
      schedulerIsLeader.set({ instance_id: INSTANCE_ID }, acquired ? 1 : 0);
      if (!acquired) {
        return;
      }
    }

    for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
      if (!this.running || !this.leaderElection.isLeader()) {
        schedulerIsLeader.set({ instance_id: INSTANCE_ID }, 0);
        return;
      }

      const summary = await db.fireDueJobs(SCAN_BATCH_SIZE, MISFIRE_GRACE_MS);
      this.recordFiring(summary);

      if (summary.jobs < SCAN_BATCH_SIZE) {
        return;
      }
    }
  }

  /** Logs and counts what a firing pass did. */
  private recordFiring(summary: db.FiringSummary): void {
    for (const fired of summary.firedSlots) {
      jobsScheduledTotal.inc({ handler: fired.handler, priority: fired.priority.toString() });
      schedulerLogger.info({
        jobId: fired.jobId,
        jobName: fired.jobName,
        slot: fired.slot.toISOString(),
      }, `Fired ${fired.jobName} for slot ${fired.slot.toISOString()}`);
    }

    if (summary.misfired > 0) {
      // `skipped` only counts misfired jobs whose policy is skip; the rest fired once.
      const firedOnce = summary.misfired - summary.skipped;
      if (firedOnce > 0) misfiresTotal.inc({ policy: 'fire_once' }, firedOnce);
      if (summary.skipped > 0) misfiresTotal.inc({ policy: 'skip' }, summary.skipped);
      schedulerLogger.warn({
        misfired: summary.misfired,
        skipped: summary.skipped,
      }, 'Due jobs were later than the misfire grace window');
    }

    if (summary.duplicates > 0) {
      schedulerLogger.warn(
        { duplicates: summary.duplicates },
        'Slots already had an execution (another scheduler fired them); nothing inserted'
      );
    }
  }

  /**
   * Leader-only: reclaims executions whose lease lapsed. Each reclaimed lease counts as
   * a failed attempt, so it is retried with backoff or dead-lettered.
   */
  private async reap(): Promise<void> {
    if (this.reaping || !this.running || !this.leaderElection.isLeader()) {
      return;
    }

    this.reaping = true;
    try {
      const reaped = await db.reapExpiredLeases(REAPER_BATCH_SIZE);
      for (const lease of reaped) {
        stalledJobsRecovered.inc({ outcome: lease.outcome.outcome });
        schedulerLogger.warn({
          executionId: lease.executionId,
          jobId: lease.jobId,
          workerId: lease.workerId,
          outcome: lease.outcome,
        }, `Reclaimed expired lease on execution ${lease.executionId}`);
      }
    } catch (error) {
      schedulerLogger.error({ err: error }, 'Error in lease reaper');
    } finally {
      this.reaping = false;
    }
  }

  /** Refreshes the queue gauges from PostgreSQL. */
  private async refreshQueueMetrics(): Promise<void> {
    try {
      await updateQueueMetrics(await db.getQueueStats());
    } catch (error) {
      schedulerLogger.error({ err: error }, 'Error updating queue metrics');
    }
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
   * @returns True while this instance holds an unexpired leader lease
   */
  isLeader(): boolean {
    return this.leaderElection.isLeader();
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
 * Graceful shutdown: release the lease so a standby takes over without waiting for the
 * TTL, then close connections.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  schedulerLogger.info(`Received ${signal}, shutting down...`);
  try {
    await scheduler.stop();
    await pool.end();
    await disconnectRedis();
  } catch (error) {
    schedulerLogger.error({ err: error }, 'Error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Start the scheduler
scheduler.start().catch((error) => {
  schedulerLogger.error({ err: error }, 'Failed to start scheduler');
  process.exit(1);
});

export { scheduler };
