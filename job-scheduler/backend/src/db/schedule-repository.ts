/**
 * Schedule repository: firing due jobs, pausing and resuming.
 * @module db/schedule-repository
 */

import { query, queryOne, withTransaction } from './pool';
import { Job } from './types';
import { JobStatus } from '../types/index';
import { getJob } from './job-repository';
import { nextCronTime, planFiring } from '../scheduler/cron';

/** One slot that a firing pass turned into an execution. */
export interface FiredSlot {
  jobId: string;
  jobName: string;
  handler: string;
  priority: number;
  slot: Date;
}

/** What one firing pass did. */
export interface FiringSummary {
  /** Due jobs locked and processed in this pass. */
  jobs: number;
  /** Executions inserted (one per fired slot). */
  fired: number;
  /** Details of each inserted execution, for metrics and logs. */
  firedSlots: FiredSlot[];
  /** Slots that already had an execution (another scheduler fired them first). */
  duplicates: number;
  /** Jobs found later than the grace window. */
  misfired: number;
  /** Misfired slots dropped because the job's policy is `skip`. */
  skipped: number;
}

/**
 * Fires every due job in one transaction and advances its next_run_time.
 *
 * Correctness does not depend on being the only scheduler:
 * 1. Due jobs are locked with FOR UPDATE SKIP LOCKED inside this transaction, so two
 *    schedulers that both think they lead (a split brain during failover) lock
 *    disjoint rows, and a job is invisible as "due" once its next_run_time has moved.
 * 2. The execution insert is keyed by (job_id, scheduled_at = slot, attempt = 1) with
 *    ON CONFLICT DO NOTHING, so a slot that was somehow fired twice yields one row.
 * 3. Inserting the execution and advancing next_run_time commit together: a crash in
 *    between leaves neither, and the next tick simply fires the slot.
 * The leader lock only stops followers from doing redundant work.
 *
 * @param limit - maximum jobs per pass (a tick catches up over several passes)
 * @param graceMs - lateness that still counts as on time (see planFiring)
 */
export async function fireDueJobs(limit: number, graceMs: number): Promise<FiringSummary> {
  return withTransaction(async (client) => {
    const { rows: due } = await client.query<Job & { db_now: Date }>(
      `SELECT jobs.*, NOW() AS db_now
       FROM jobs
       WHERE status = 'SCHEDULED' AND next_run_time <= NOW()
       ORDER BY next_run_time ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    const summary: FiringSummary = {
      jobs: due.length,
      fired: 0,
      firedSlots: [],
      duplicates: 0,
      misfired: 0,
      skipped: 0,
    };

    for (const job of due) {
      const plan = planFiring(
        {
          schedule: job.schedule,
          next_run_time: job.next_run_time as Date,
          misfire_policy: job.misfire_policy,
        },
        job.db_now,
        graceMs
      );

      if (plan.misfired) {
        summary.misfired++;
      }

      if (plan.fireSlot) {
        const { rowCount } = await client.query(
          `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
           VALUES ($1, 'PENDING', 1, $2, NOW(), $3)
           ON CONFLICT (job_id, scheduled_at, attempt) DO NOTHING`,
          [job.id, plan.fireSlot, job.priority]
        );
        if (rowCount === 1) {
          summary.fired++;
          summary.firedSlots.push({
            jobId: job.id,
            jobName: job.name,
            handler: job.handler,
            priority: job.priority,
            slot: plan.fireSlot,
          });
        } else {
          summary.duplicates++;
        }
      } else {
        summary.skipped++;
      }

      // Recurring jobs stay SCHEDULED with a future next_run_time; a one-time job
      // becomes QUEUED with no next_run_time, so it can never be selected as due again.
      await client.query(
        'UPDATE jobs SET next_run_time = $2, status = $3 WHERE id = $1',
        [job.id, plan.nextRunTime, job.schedule ? JobStatus.SCHEDULED : JobStatus.QUEUED]
      );
    }

    return summary;
  });
}

/**
 * Pauses a job. A paused job is never fired, and its PENDING executions (including
 * retries waiting on backoff) are held by the claim query until it is resumed.
 * Executions already RUNNING finish; their status writes never overwrite PAUSED.
 * @returns the paused job, or null if it does not exist or is already finished/paused
 */
export async function pauseJob(id: string): Promise<Job | null> {
  return queryOne<Job>(
    `UPDATE jobs SET status = $2
     WHERE id = $1 AND status IN ('SCHEDULED', 'QUEUED', 'RUNNING')
     RETURNING *`,
    [id, JobStatus.PAUSED]
  );
}

/**
 * Resumes a paused job.
 *
 * - Recurring job: next_run_time restarts from now, so the slots missed while paused
 *   are not replayed as a burst.
 * - One-time job that has not fired yet: back to SCHEDULED at its original time.
 * - One-time job that already fired: its status is derived from its latest run.
 *
 * @returns the resumed job, or null if it does not exist or is not paused
 */
export async function resumeJob(id: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job || job.status !== JobStatus.PAUSED) {
    return null;
  }

  if (job.schedule) {
    return queryOne<Job>(
      `UPDATE jobs SET status = $2, next_run_time = $3
       WHERE id = $1 AND status = 'PAUSED'
       RETURNING *`,
      [id, JobStatus.SCHEDULED, nextCronTime(job.schedule, new Date())]
    );
  }

  const latest = await query<{ status: string }>(
    `SELECT status FROM job_executions WHERE job_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  const latestStatus = latest[0]?.status;
  let status: JobStatus = JobStatus.SCHEDULED;
  if (!job.next_run_time && latestStatus) {
    if (latestStatus === 'COMPLETED') status = JobStatus.COMPLETED;
    else if (latestStatus === 'DEAD_LETTER') status = JobStatus.FAILED;
    else if (latestStatus === 'PENDING') status = JobStatus.QUEUED;
    else if (latestStatus === 'RUNNING') status = JobStatus.RUNNING;
  }

  return queryOne<Job>(
    `UPDATE jobs SET status = $2 WHERE id = $1 AND status = 'PAUSED' RETURNING *`,
    [id, status]
  );
}
