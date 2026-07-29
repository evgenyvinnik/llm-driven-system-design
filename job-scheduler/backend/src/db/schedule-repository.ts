/**
 * Schedule repository module for job scheduling operations.
 * Handles scheduling, pausing, resuming, and fetching due jobs.
 * @module db/schedule-repository
 */

import cronParser from 'cron-parser';
import { query, queryOne } from './pool';
import { Job } from './types';
import { JobStatus } from '../types/index';
import { logger } from '../utils/logger';
import { getJob, updateJobStatus } from './job-repository';

/**
 * Retrieves jobs due for execution.
 *
 * @description Fetches jobs that are scheduled to run now or in the recent past.
 * Uses FOR UPDATE SKIP LOCKED for distributed safety when multiple scheduler
 * instances are running. Only returns jobs scheduled in the last 5 minutes to
 * avoid processing stale schedules.
 *
 * @param {number} [limit=100] - Maximum number of jobs to retrieve
 * @returns {Promise<Job[]>} Array of jobs ready to be scheduled for execution
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Scheduler loop fetching due jobs
 * const dueJobs = await getDueJobs(50);
 * for (const job of dueJobs) {
 *   await queueJobForExecution(job);
 * }
 */
export async function getDueJobs(limit: number = 100): Promise<Job[]> {
  return query<Job>(
    `SELECT * FROM jobs
     WHERE status = 'SCHEDULED'
       AND next_run_time <= NOW()
       AND next_run_time > NOW() - INTERVAL '5 minutes'
     ORDER BY priority DESC, next_run_time ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
}

/**
 * Calculates and sets the next run time for a recurring job.
 *
 * @description Called after a job execution completes to schedule the next occurrence.
 * Parses the job's cron expression and calculates the next valid run time.
 * Non-recurring jobs (without a schedule) are not modified.
 *
 * @param {string} jobId - UUID of the job
 * @returns {Promise<Job | null>} Updated job with new next_run_time, or null if:
 *   - Job not found
 *   - Job has no cron schedule (one-time job)
 *   - Cron expression parsing fails
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // After successful execution
 * const nextScheduled = await scheduleNextRun(job.id);
 * if (nextScheduled) {
 *   console.log(`Next run at: ${nextScheduled.next_run_time}`);
 * }
 */
export async function scheduleNextRun(jobId: string): Promise<Job | null> {
  const job = await getJob(jobId);
  if (!job || !job.schedule) {
    return null;
  }

  try {
    const interval = cronParser.parseExpression(job.schedule);
    const nextRunTime = interval.next().toDate();

    return queryOne<Job>(
      'UPDATE jobs SET next_run_time = $1, status = $2 WHERE id = $3 RETURNING *',
      [nextRunTime, JobStatus.SCHEDULED, jobId]
    );
  } catch (error) {
    logger.error(`Failed to calculate next run time for job ${jobId}`, error);
    return null;
  }
}

/**
 * Pauses a job, preventing it from being scheduled.
 *
 * @description Sets the job status to PAUSED, which excludes it from the
 * getDueJobs query. The job's schedule and next_run_time are preserved
 * for resumption later.
 *
 * @param {string} id - UUID of the job to pause
 * @returns {Promise<Job | null>} Updated job with PAUSED status, or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const paused = await pauseJob(jobId);
 * if (paused) {
 *   console.log(`Job ${paused.name} paused`);
 * }
 */
export async function pauseJob(id: string): Promise<Job | null> {
  return updateJobStatus(id, JobStatus.PAUSED);
}

/**
 * Resumes a paused job, recalculating the next run time for recurring jobs.
 *
 * @description Restores a paused job to SCHEDULED status. For recurring jobs,
 * recalculates next_run_time based on the current time and cron schedule.
 * Only works on jobs that are currently in PAUSED status.
 *
 * @param {string} id - UUID of the job to resume
 * @returns {Promise<Job | null>} Updated job with SCHEDULED status, or null if:
 *   - Job not found
 *   - Job is not in PAUSED status
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const resumed = await resumeJob(jobId);
 * if (resumed) {
 *   console.log(`Job resumed, next run: ${resumed.next_run_time}`);
 * } else {
 *   console.log('Job not found or not paused');
 * }
 */
export async function resumeJob(id: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job || job.status !== JobStatus.PAUSED) {
    return null;
  }

  // Recalculate next run time for recurring jobs
  if (job.schedule) {
    const interval = cronParser.parseExpression(job.schedule);
    const nextRunTime = interval.next().toDate();
    return queryOne<Job>(
      'UPDATE jobs SET status = $1, next_run_time = $2 WHERE id = $3 RETURNING *',
      [JobStatus.SCHEDULED, nextRunTime, id]
    );
  }

  return updateJobStatus(id, JobStatus.SCHEDULED);
}
