/**
 * Execution repository module for job execution records.
 * Handles creating, reading, updating executions and execution logs.
 * @module db/execution-repository
 */

import { query, queryOne } from './pool';
import { JobExecution, Job, ExecutionLog, PaginatedResponse, CountResult, EXECUTION_FIELD_MAP } from './types';
import { calculateOffset, buildWhereClause } from './queries';
import { ExecutionStatus } from '../types/index';

/**
 * Creates a new execution record for a job.
 *
 * @description Inserts a new execution record to track an individual job run.
 * Each execution captures timing, status, attempt number, and results.
 * Initial status is always PENDING.
 *
 * @param {string} jobId - UUID of the job being executed
 * @param {Date} [scheduledAt=new Date()] - When the execution was scheduled (defaults to now)
 * @param {number} [attempt=1] - Attempt number for retry tracking (defaults to 1)
 * @returns {Promise<JobExecution>} The created execution record with generated ID
 * @throws {Error} If database insert fails
 *
 * @example
 * // Create initial execution
 * const execution = await createExecution(job.id);
 *
 * @example
 * // Create retry execution with attempt number
 * const retry = await createExecution(job.id, new Date(), 2);
 */
export async function createExecution(
  jobId: string,
  scheduledAt: Date = new Date(),
  attempt: number = 1
): Promise<JobExecution> {
  const result = await queryOne<JobExecution>(
    `INSERT INTO job_executions (job_id, status, attempt, scheduled_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [jobId, ExecutionStatus.PENDING, attempt, scheduledAt]
  );

  if (!result) {
    throw new Error('Failed to create execution');
  }

  return result;
}

/**
 * Retrieves an execution by its unique identifier.
 *
 * @description Fetches a single execution record from the database by UUID.
 *
 * @param {string} id - UUID of the execution
 * @returns {Promise<JobExecution | null>} Execution record or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const execution = await getExecution(executionId);
 * if (execution) {
 *   console.log(`Status: ${execution.status}, Attempt: ${execution.attempt}`);
 * }
 */
export async function getExecution(id: string): Promise<JobExecution | null> {
  return queryOne<JobExecution>('SELECT * FROM job_executions WHERE id = $1', [id]);
}

/**
 * Retrieves an execution with its associated job data.
 *
 * @description Fetches an execution record along with the complete job definition.
 * Used when workers need both execution state and job configuration (handler, payload, etc.).
 *
 * @param {string} id - UUID of the execution
 * @returns {Promise<(JobExecution & { job: Job }) | null>} Execution with embedded job, or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const executionWithJob = await getExecutionWithJob(executionId);
 * if (executionWithJob) {
 *   const { job } = executionWithJob;
 *   console.log(`Executing ${job.name} with handler ${job.handler}`);
 * }
 */
export async function getExecutionWithJob(id: string): Promise<(JobExecution & { job: Job }) | null> {
  const result = await queryOne<JobExecution & { job: Job }>(
    `SELECT e.*, row_to_json(j.*) as job
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     WHERE e.id = $1`,
    [id]
  );
  return result;
}

/**
 * Lists executions with pagination and optional filtering.
 *
 * @description Retrieves a paginated list of executions ordered by creation date (newest first).
 * Supports filtering by job ID and/or execution status.
 *
 * @param {string} [jobId] - Optional job UUID to filter by
 * @param {number} [page=1] - Page number (1-indexed)
 * @param {number} [limit=20] - Maximum executions per page
 * @param {ExecutionStatus} [status] - Optional status filter (e.g., 'RUNNING', 'COMPLETED')
 * @returns {Promise<PaginatedResponse<JobExecution>>} Paginated response containing:
 *   - items: Array of execution records
 *   - total: Total count matching the filters
 *   - page: Current page number
 *   - limit: Items per page
 *   - total_pages: Total number of pages
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Get all executions for a job
 * const { items } = await listExecutions(jobId);
 *
 * @example
 * // Get failed executions across all jobs
 * const failed = await listExecutions(undefined, 1, 50, ExecutionStatus.FAILED);
 */
export async function listExecutions(
  jobId?: string,
  page: number = 1,
  limit: number = 20,
  status?: ExecutionStatus
): Promise<PaginatedResponse<JobExecution>> {
  const offset = calculateOffset(page, limit);
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (jobId) {
    conditions.push(`job_id = $${paramIndex}`);
    params.push(jobId);
    paramIndex++;
  }

  if (status) {
    conditions.push(`status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }

  const whereClause = buildWhereClause(conditions);

  params.push(limit, offset);
  const executions = await query<JobExecution>(
    `SELECT * FROM job_executions ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  const countParams = jobId || status ? params.slice(0, -2) : [];
  const countResult = await query<CountResult>(
    `SELECT COUNT(*) as count FROM job_executions ${whereClause}`,
    countParams
  );
  const total = parseInt(countResult[0]?.count || '0', 10);

  return {
    items: executions,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

/**
 * Updates an execution record with new values.
 *
 * @description Modifies an execution's state during processing. Used to update
 * status transitions, timing information, results, and error details.
 * Only specified fields are updated; others remain unchanged.
 *
 * @param {string} id - UUID of the execution
 * @param {Partial<Omit<JobExecution, 'id' | 'job_id' | 'created_at'>>} updates - Fields to update:
 *   - status: New execution status
 *   - attempt: Current attempt number
 *   - started_at: When execution began
 *   - completed_at: When execution finished
 *   - next_retry_at: When to retry (for PENDING_RETRY status)
 *   - result: Execution result data (serialized to JSON)
 *   - error: Error message if failed
 *   - worker_id: ID of the worker processing this execution
 * @returns {Promise<JobExecution | null>} Updated execution or null if not found
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Mark execution as started
 * await updateExecution(executionId, {
 *   status: ExecutionStatus.RUNNING,
 *   started_at: new Date(),
 *   worker_id: 'worker-1'
 * });
 *
 * @example
 * // Mark execution as completed
 * await updateExecution(executionId, {
 *   status: ExecutionStatus.COMPLETED,
 *   completed_at: new Date(),
 *   result: { itemsProcessed: 150 }
 * });
 */
export async function updateExecution(
  id: string,
  updates: Partial<Omit<JobExecution, 'id' | 'job_id' | 'created_at'>>
): Promise<JobExecution | null> {
  const updateFields: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  for (const [key, column] of Object.entries(EXECUTION_FIELD_MAP)) {
    if (key in updates) {
      updateFields.push(`${column} = $${paramIndex}`);
      const value = updates[key as keyof typeof updates];
      params.push(key === 'result' && value ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }

  if (updateFields.length === 0) {
    return getExecution(id);
  }

  params.push(id);
  return queryOne<JobExecution>(
    `UPDATE job_executions SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );
}

/**
 * Retrieves executions in PENDING_RETRY status that are ready for retry.
 *
 * @description Fetches executions that have failed but are scheduled for retry
 * and whose retry time has arrived. Uses FOR UPDATE SKIP LOCKED for safe
 * concurrent processing by multiple worker instances.
 *
 * @param {number} [limit=50] - Maximum number of executions to retrieve
 * @returns {Promise<JobExecution[]>} Array of executions ready for retry
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Retry processor loop
 * const retryable = await getRetryableExecutions(25);
 * for (const execution of retryable) {
 *   await requeueExecution(execution);
 * }
 */
export async function getRetryableExecutions(limit: number = 50): Promise<JobExecution[]> {
  return query<JobExecution>(
    `SELECT * FROM job_executions
     WHERE status = 'PENDING_RETRY'
       AND next_retry_at <= NOW()
     ORDER BY next_retry_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
}

/**
 * Adds a log entry for an execution.
 *
 * @description Creates a log record associated with an execution. Job handlers
 * use this to record progress updates, warnings, and errors during execution.
 * Logs are useful for debugging and auditing job behavior.
 *
 * @param {string} executionId - UUID of the execution
 * @param {'info' | 'warn' | 'error'} level - Log level
 * @param {string} message - Log message text
 * @param {Record<string, unknown>} [metadata] - Optional structured metadata (serialized to JSON)
 * @returns {Promise<ExecutionLog>} The created log entry
 * @throws {Error} If database insert fails
 *
 * @example
 * // Log progress
 * await addExecutionLog(executionId, 'info', 'Processing batch 1 of 5');
 *
 * @example
 * // Log error with metadata
 * await addExecutionLog(executionId, 'error', 'Request failed', {
 *   statusCode: 500,
 *   url: 'https://api.example.com/webhook'
 * });
 */
export async function addExecutionLog(
  executionId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, unknown>
): Promise<ExecutionLog> {
  const result = await queryOne<ExecutionLog>(
    `INSERT INTO execution_logs (execution_id, level, message, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [executionId, level, message, metadata ? JSON.stringify(metadata) : null]
  );

  if (!result) {
    throw new Error('Failed to add execution log');
  }

  return result;
}

/**
 * Retrieves log entries for an execution.
 *
 * @description Fetches all log entries associated with an execution in
 * chronological order. Used for debugging and displaying execution history.
 *
 * @param {string} executionId - UUID of the execution
 * @param {number} [limit=100] - Maximum number of log entries to retrieve
 * @returns {Promise<ExecutionLog[]>} Array of log entries in chronological order
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const logs = await getExecutionLogs(executionId);
 * logs.forEach(log => {
 *   console.log(`[${log.level}] ${log.message}`);
 * });
 */
export async function getExecutionLogs(
  executionId: string,
  limit: number = 100
): Promise<ExecutionLog[]> {
  return query<ExecutionLog>(
    `SELECT * FROM execution_logs
     WHERE execution_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [executionId, limit]
  );
}
