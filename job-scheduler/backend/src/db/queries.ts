/**
 * Reusable query helpers for database operations.
 * Provides utilities for building dynamic queries and handling common patterns.
 * @module db/queries
 */

import { query, queryOne } from './pool';
import { CountResult, SystemMetrics, SystemMetricsResult, HourlyStats } from './types';

/**
 * Builds a WHERE clause from an array of conditions.
 *
 * @description Joins multiple SQL condition strings with AND operators and
 * prepends the WHERE keyword. Returns an empty string if no conditions provided.
 *
 * @param {string[]} conditions - Array of SQL condition strings (e.g., 'status = $1')
 * @returns {string} Formatted WHERE clause or empty string if no conditions
 *
 * @example
 * const conditions = ['status = $1', 'created_at > $2'];
 * const where = buildWhereClause(conditions);
 * // Returns: 'WHERE status = $1 AND created_at > $2'
 *
 * @example
 * const where = buildWhereClause([]);
 * // Returns: ''
 */
export function buildWhereClause(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

/**
 * Calculates pagination offset from page number and limit.
 *
 * @description Converts 1-indexed page numbers to SQL OFFSET values.
 * Page 1 returns offset 0, page 2 returns offset equal to limit, etc.
 *
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Items per page
 * @returns {number} Offset value for SQL OFFSET clause
 *
 * @example
 * const offset = calculateOffset(1, 20); // Returns: 0
 * const offset = calculateOffset(2, 20); // Returns: 20
 * const offset = calculateOffset(3, 10); // Returns: 20
 */
export function calculateOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * Gets total count from a table with optional WHERE clause.
 *
 * @description Executes a COUNT(*) query on the specified table with an optional
 * filter condition. Useful for pagination total calculations.
 *
 * @param {string} table - Table name to count rows from
 * @param {string} [whereClause] - Optional WHERE clause condition (without WHERE keyword)
 * @param {unknown[]} [params=[]] - Parameters for the WHERE clause placeholders
 * @returns {Promise<number>} Total count as a number
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Count all jobs
 * const total = await getCount('jobs'); // Returns: 42
 *
 * @example
 * // Count jobs with specific status
 * const activeCount = await getCount('jobs', 'status = $1', ['SCHEDULED']);
 */
export async function getCount(
  table: string,
  whereClause?: string,
  params: unknown[] = []
): Promise<number> {
  const sql = whereClause
    ? `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`
    : `SELECT COUNT(*) as count FROM ${table}`;

  const result = await query<CountResult>(sql, params);
  return parseInt(result[0]?.count || '0', 10);
}

/**
 * Retrieves aggregated system metrics for dashboard display.
 *
 * @description Provides a comprehensive snapshot of system health including
 * counts of jobs, executions by status, and 24-hour completion statistics.
 * All counts are returned as parsed numbers.
 *
 * @returns {Promise<SystemMetrics>} Object containing:
 *   - total_jobs: Total number of jobs in the system
 *   - active_jobs: Jobs with SCHEDULED, QUEUED, or RUNNING status
 *   - queued_executions: Executions waiting to be processed
 *   - running_executions: Currently executing jobs
 *   - completed_24h: Successfully completed executions in last 24 hours
 *   - failed_24h: Failed executions in last 24 hours
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * const metrics = await getSystemMetrics();
 * console.log(`${metrics.active_jobs} jobs active, ${metrics.completed_24h} completed today`);
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const result = await queryOne<SystemMetricsResult>(`
    SELECT
      (SELECT COUNT(*) FROM jobs) as total_jobs,
      (SELECT COUNT(*) FROM jobs WHERE status IN ('SCHEDULED', 'QUEUED', 'RUNNING')) as active_jobs,
      (SELECT COUNT(*) FROM job_executions WHERE status = 'PENDING') as queued_executions,
      (SELECT COUNT(*) FROM job_executions WHERE status = 'RUNNING') as running_executions,
      (SELECT COUNT(*) FROM job_executions WHERE status = 'COMPLETED' AND completed_at > NOW() - INTERVAL '24 hours') as completed_24h,
      (SELECT COUNT(*) FROM job_executions WHERE status = 'FAILED' AND completed_at > NOW() - INTERVAL '24 hours') as failed_24h
  `);

  if (!result) {
    return {
      total_jobs: 0,
      active_jobs: 0,
      queued_executions: 0,
      running_executions: 0,
      completed_24h: 0,
      failed_24h: 0,
    };
  }

  return {
    total_jobs: parseInt(result.total_jobs, 10),
    active_jobs: parseInt(result.active_jobs, 10),
    queued_executions: parseInt(result.queued_executions, 10),
    running_executions: parseInt(result.running_executions, 10),
    completed_24h: parseInt(result.completed_24h, 10),
    failed_24h: parseInt(result.failed_24h, 10),
  };
}

/**
 * Retrieves hourly execution statistics for charting.
 *
 * @description Aggregates job execution data by hour for displaying trends
 * in the dashboard. Includes completed and failed counts plus average duration.
 *
 * @param {number} [hours=24] - Number of hours of history to retrieve (default: 24)
 * @returns {Promise<HourlyStats[]>} Array of hourly statistics containing:
 *   - hour: Timestamp truncated to the hour
 *   - completed: Count of completed executions in that hour
 *   - failed: Count of failed executions in that hour
 *   - avg_duration_ms: Average execution duration in milliseconds
 * @throws {Error} Database errors from the underlying query
 *
 * @example
 * // Get last 24 hours of stats
 * const stats = await getExecutionStats();
 *
 * @example
 * // Get last 7 days of stats
 * const weeklyStats = await getExecutionStats(168);
 */
export async function getExecutionStats(hours: number = 24): Promise<HourlyStats[]> {
  return query<HourlyStats>(
    `SELECT
      date_trunc('hour', completed_at) as hour,
      COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
      COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
      AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
    FROM job_executions
    WHERE completed_at > NOW() - INTERVAL '${hours} hours'
    GROUP BY date_trunc('hour', completed_at)
    ORDER BY hour ASC`,
    []
  );
}
