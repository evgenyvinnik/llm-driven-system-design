/**
 * Job repository module for job CRUD operations.
 * Handles creating, reading, updating, and deleting jobs.
 * @module db/job-repository
 */

import { v4 as uuidv4 } from 'uuid';
import cronParser from 'cron-parser';
import { query, queryOne } from './pool.js';
import { Job, JobWithStats, PaginatedResponse, CountResult } from './types.js';
import { calculateOffset } from './queries.js';
import { JobStatus, CreateJobInput, UpdateJobInput } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a new job in the database.
 * Parses cron expressions to calculate the next run time for recurring jobs.
 * @param input - Job creation parameters
 * @returns The created job record
 * @throws Error if cron expression is invalid
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
 * @param id - UUID of the job
 * @returns The job record or null if not found
 */
export async function getJob(id: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
}

/**
 * Retrieves a job by its unique name.
 * Used for deduplication when creating jobs.
 * @param name - Unique name of the job
 * @returns The job record or null if not found
 */
export async function getJobByName(name: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE name = $1', [name]);
}

/**
 * Lists jobs with pagination and optional status filtering.
 * @param page - Page number (1-indexed)
 * @param limit - Maximum jobs per page
 * @param status - Optional status filter
 * @returns Paginated response with job list and metadata
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
 * Joins with execution data to provide success/failure counts and timing info.
 * Used in the dashboard and job list views.
 * @param page - Page number (1-indexed)
 * @param limit - Maximum jobs per page
 * @returns Paginated response with job stats
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
 * Only provided fields are updated; others remain unchanged.
 * Recalculates next_run_time if the schedule changes.
 * @param id - UUID of the job to update
 * @param input - Fields to update
 * @returns Updated job record or null if not found
 * @throws Error if new cron expression is invalid
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
 * Cascade deletion is handled by the database foreign key constraints.
 * @param id - UUID of the job to delete
 * @returns True if the job was deleted, false if not found
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
 * @param id - UUID of the job
 * @param status - New status value
 * @returns Updated job or null if not found
 */
export async function updateJobStatus(id: string, status: JobStatus): Promise<Job | null> {
  return queryOne<Job>(
    'UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
}
