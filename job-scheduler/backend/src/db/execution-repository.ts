/**
 * Execution repository module: read paths for execution records and execution logs.
 * State changes (claim, complete, fail, retry, cancel) live in execution-queue.ts,
 * where every write is fenced on the lease that owns the attempt.
 * @module db/execution-repository
 */

import { query, queryOne } from './pool';
import { JobExecution, ExecutionLog, PaginatedResponse, CountResult } from './types';
import { calculateOffset, buildWhereClause } from './queries';
import { ExecutionStatus } from '../types/index';

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
