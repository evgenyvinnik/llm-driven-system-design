/**
 * Job repository module for job CRUD operations.
 * Handles creating, reading, updating, and deleting jobs.
 * @module db/job-repository
 */

import { v4 as uuidv4 } from 'uuid';
import cronParser from 'cron-parser';
import { query, queryOne } from './pool';
import { Job, JobWithStats, PaginatedResponse, CountResult } from './types';
import { calculateOffset } from './queries';
import { JobStatus, CreateJobInput, UpdateJobInput } from '../types/index';
import { logger } from '../utils/logger';

/**
 * Creates a new job in the database.
 *
 * @description Inserts a new job record with the provided configuration.
 * For recurring jobs with a cron schedule, automatically calculates the next run time.
 * For one-time jobs, uses the provided scheduled_at timestamp.
 *
 * @param {CreateJobInput} input - Job creation parameters including:
 *   - name: Unique job identifier
 *   - handler: Handler function to execute (e.g., 'http.webhook', 'test.echo')
 *   - description: Optional human-readable description
 *   - payload: Data passed to the handler
 *   - schedule: Cron expression for recurring jobs
 *   - scheduled_at: One-time execution timestamp
 *   - priority: Execution priority (0-100, default 50)
 *   - max_retries: Maximum retry attempts (default 3)
 *   - timeout_ms: Execution timeout in milliseconds (default 300000)
 * @returns {Promise<Job>} The created job record with generated ID and timestamps
 * @throws {Error} If cron expression is invalid or database insert fails
 *
 * @example
 * // Create a recurring job
 * const job = await createJob({
 *   name: 'daily-report',
 *   handler: 'email.send',
 *   schedule: '0 9 * * *', // Every day at 9 AM
 *   payload: { template: 'daily-summary' }
 * });
 *
 * @example
 * // Create a one-time job
 * const job = await createJob({
 *   name: 'send-welcome-email',
 *   handler: 'email.send',
 *   scheduled_at: new Date('2024-01-15T10:00:00Z'),
 *   payload: { userId: '123', template: 'welcome' }
 * });
 */
export async function createJob(input: CreateJobInput): Promise<Job> {
  const id = uuidv4();
  let nextRunTime: Date | null = null;

  if (input.schedule) {
    try {
      const interval = cronParser.parseExpression(input.schedule);
      nextRunTime = interval.next().toDate();
    } catch (_error) {
      throw new Error(`Invalid cron expression: ${input.schedule}`);
    }
  } else if (input.scheduled_at) {
    nextRunTime = input.scheduled_at;
  }

  const result = await queryOne<Job>(
    `INSERT INTO jobs (
      id, name, description, handler, payload, schedule, next_run_time,
      priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      id,
      input.name,
      input.description || null,
      input.handler,
      JSON.stringify(input.payload || {}),
      input.schedule || null,
      nextRunTime,
      input.priority ?? 50,
      input.max_retries ?? 3,
      input.initial_backoff_ms ?? 1000,
      input.max_backoff_ms ?? 3600000,
      input.timeout_ms ?? 300000,
      JobStatus.SCHEDULED,
    ]
  );

  if (!result) {
    throw new Error('Failed to create job');
  }

  logger.info(`Job created: ${result.id}`, { jobId: result.id, name: input.name });
  return result;
}

/**
 * Retrieves a job by its unique identifier.
 *
 * @description Fetches a single job record from the database by UUID.
 *
 * @param {string} id - UUID of the job to retrieve
 * @returns {Promise<Job | null>} The job record or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const job = await getJob('550e8400-e29b-41d4-a716-446655440000');
 * if (job) {
 *   console.log(`Found job: ${job.name}`);
 * }
 */
export async function getJob(id: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
}

/**
 * Retrieves a job by its unique name.
 *
 * @description Looks up a job by its human-readable name. Useful for checking
 * if a job already exists before creating it (deduplication).
 *
 * @param {string} name - Unique name of the job
 * @returns {Promise<Job | null>} The job record or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const existing = await getJobByName('daily-cleanup');
 * if (!existing) {
 *   await createJob({ name: 'daily-cleanup', handler: 'system.cleanup' });
 * }
 */
export async function getJobByName(name: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE name = $1', [name]);
}

/**
 * Lists jobs with pagination and optional status filtering.
 *
 * @description Retrieves a paginated list of jobs ordered by creation date (newest first).
 * Supports filtering by job status.
 *
 * @param {number} [page=1] - Page number (1-indexed)
 * @param {number} [limit=20] - Maximum jobs per page
 * @param {JobStatus} [status] - Optional status filter (e.g., 'SCHEDULED', 'PAUSED')
 * @returns {Promise<PaginatedResponse<Job>>} Paginated response containing:
 *   - items: Array of job records
 *   - total: Total count matching the filter
 *   - page: Current page number
 *   - limit: Items per page
 *   - total_pages: Total number of pages
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Get first page of all jobs
 * const { items, total } = await listJobs();
 *
 * @example
 * // Get paused jobs, page 2
 * const paused = await listJobs(2, 10, JobStatus.PAUSED);
 */
export async function listJobs(
  page: number = 1,
  limit: number = 20,
  status?: JobStatus
): Promise<PaginatedResponse<Job>> {
  const offset = calculateOffset(page, limit);
  let whereClause = '';
  const params: unknown[] = [limit, offset];

  if (status) {
    whereClause = 'WHERE status = $3';
    params.push(status);
  }

  const [jobs, countResult] = await Promise.all([
    query<Job>(
      `SELECT * FROM jobs ${whereClause} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params
    ),
    query<CountResult>(
      `SELECT COUNT(*) as count FROM jobs ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    ),
  ]);

  const total = parseInt(countResult[0]?.count || '0', 10);

  return {
    items: jobs,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

/**
 * Lists jobs with aggregated execution statistics.
 *
 * @description Retrieves jobs with calculated stats from their execution history.
 * Includes success/failure counts, last execution time, and average duration.
 * Used in the dashboard and job list views for monitoring.
 *
 * @param {number} [page=1] - Page number (1-indexed)
 * @param {number} [limit=20] - Maximum jobs per page
 * @returns {Promise<PaginatedResponse<JobWithStats>>} Paginated response with job stats:
 *   - items: Jobs with additional stats fields:
 *     - total_executions: Total execution count
 *     - successful_executions: Completed execution count
 *     - failed_executions: Failed execution count
 *     - last_execution_at: Timestamp of most recent execution
 *     - avg_duration_ms: Average execution duration
 *   - total, page, limit, total_pages: Pagination metadata
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const { items } = await listJobsWithStats();
 * items.forEach(job => {
 *   const successRate = job.total_executions > 0
 *     ? (job.successful_executions / job.total_executions * 100).toFixed(1)
 *     : 'N/A';
 *   console.log(`${job.name}: ${successRate}% success rate`);
 * });
 */
export async function listJobsWithStats(
  page: number = 1,
  limit: number = 20
): Promise<PaginatedResponse<JobWithStats>> {
  const offset = calculateOffset(page, limit);

  const jobs = await query<JobWithStats>(
    `SELECT
      j.*,
      COALESCE(stats.total_executions, 0) as total_executions,
      COALESCE(stats.successful_executions, 0) as successful_executions,
      COALESCE(stats.failed_executions, 0) as failed_executions,
      stats.last_execution_at,
      stats.avg_duration_ms
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_executions,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as successful_executions,
        COUNT(*) FILTER (WHERE status = 'FAILED') as failed_executions,
        MAX(completed_at) as last_execution_at,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
      FROM job_executions
      WHERE job_id = j.id
    ) stats ON true
    ORDER BY j.created_at DESC
    LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await query<CountResult>('SELECT COUNT(*) as count FROM jobs', []);
  const total = parseInt(countResult[0]?.count || '0', 10);

  return {
    items: jobs,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

/**
 * Updates an existing job with new values.
 *
 * @description Modifies a job's configuration. Only provided fields are updated;
 * others remain unchanged. If the schedule changes, automatically recalculates
 * the next run time using the new cron expression.
 *
 * @param {string} id - UUID of the job to update
 * @param {UpdateJobInput} input - Fields to update (partial, only include changed fields)
 * @returns {Promise<Job | null>} Updated job record or null if not found
 * @throws {Error} If new cron expression is invalid or database update fails
 *
 * @example
 * // Update job priority
 * const updated = await updateJob(jobId, { priority: 90 });
 *
 * @example
 * // Update schedule (next_run_time auto-calculated)
 * const updated = await updateJob(jobId, {
 *   schedule: '0 0 * * *', // Every day at midnight
 *   description: 'Updated to run daily'
 * });
 */
export async function updateJob(id: string, input: UpdateJobInput): Promise<Job | null> {
  const existingJob = await getJob(id);
  if (!existingJob) {
    return null;
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  const fields: (keyof UpdateJobInput)[] = [
    'name',
    'description',
    'handler',
    'payload',
    'schedule',
    'priority',
    'max_retries',
    'initial_backoff_ms',
    'max_backoff_ms',
    'timeout_ms',
  ];

  for (const field of fields) {
    if (input[field] !== undefined) {
      updates.push(`${field} = $${paramIndex}`);
      params.push(field === 'payload' ? JSON.stringify(input[field]) : input[field]);
      paramIndex++;
    }
  }

  // Update next_run_time if schedule changed
  if (input.schedule && input.schedule !== existingJob.schedule) {
    try {
      const interval = cronParser.parseExpression(input.schedule);
      updates.push(`next_run_time = $${paramIndex}`);
      params.push(interval.next().toDate());
      paramIndex++;
    } catch (_error) {
      throw new Error(`Invalid cron expression: ${input.schedule}`);
    }
  }

  if (updates.length === 0) {
    return existingJob;
  }

  params.push(id);
  const result = await queryOne<Job>(
    `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );

  logger.info(`Job updated: ${id}`, { jobId: id, updates: Object.keys(input) });
  return result;
}

/**
 * Permanently deletes a job and its associated executions.
 *
 * @description Removes a job from the database. Cascade deletion handled by
 * foreign key constraints automatically removes all related execution records
 * and logs.
 *
 * @param {string} id - UUID of the job to delete
 * @returns {Promise<boolean>} True if the job was deleted, false if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const deleted = await deleteJob(jobId);
 * if (deleted) {
 *   console.log('Job and all executions removed');
 * } else {
 *   console.log('Job not found');
 * }
 */
export async function deleteJob(id: string): Promise<boolean> {
  const result = await query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
  if (result.length > 0) {
    logger.info(`Job deleted: ${id}`);
    return true;
  }
  return false;
}

/**
 * Updates the status of a job.
 *
 * @description Changes a job's status without modifying other fields.
 * Common status transitions include SCHEDULED to PAUSED, or PAUSED to SCHEDULED.
 *
 * @param {string} id - UUID of the job
 * @param {JobStatus} status - New status value (e.g., 'SCHEDULED', 'PAUSED', 'COMPLETED')
 * @returns {Promise<Job | null>} Updated job or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Pause a job
 * await updateJobStatus(jobId, JobStatus.PAUSED);
 *
 * @example
 * // Mark job as completed
 * await updateJobStatus(jobId, JobStatus.COMPLETED);
 */
export async function updateJobStatus(id: string, status: JobStatus): Promise<Job | null> {
  return queryOne<Job>(
    'UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
}
