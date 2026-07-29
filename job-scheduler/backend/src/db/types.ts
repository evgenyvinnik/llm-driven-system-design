/**
 * Shared types for database repository modules.
 * These types are used across job, execution, and schedule repositories.
 * @module db/types
 */

import {
  Job,
  JobExecution,
  JobWithStats,
  ExecutionLog,
  PaginatedResponse,
} from '../types/index';

/**
 * Re-export main types for convenience.
 * Consumers can import these from db/types instead of the main types module.
 */
export type {
  Job,
  JobExecution,
  JobWithStats,
  ExecutionLog,
  PaginatedResponse,
};

/**
 * Common count result from aggregate queries.
 *
 * @description Represents the result of a COUNT(*) query. PostgreSQL returns
 * counts as strings (bigint), so this must be parsed to number.
 */
export interface CountResult {
  /** Count value as string (parse with parseInt before use) */
  count: string;
}

/**
 * Hourly execution statistics for dashboard charts.
 *
 * @description Aggregated execution data grouped by hour for trend visualization.
 * Returned by getExecutionStats() for charting completed/failed executions over time.
 */
export interface HourlyStats {
  /** Hour timestamp (truncated to the hour) */
  hour: Date;
  /** Number of completed executions in this hour */
  completed: number;
  /** Number of failed executions in this hour */
  failed: number;
  /** Average execution duration in milliseconds (null if no completed executions) */
  avg_duration_ms: number;
}

/**
 * Aggregated system metrics from the database (raw string values).
 *
 * @description Raw query result from getSystemMetrics(). Values are strings
 * because PostgreSQL COUNT returns bigint. Convert to SystemMetrics for use.
 * @internal Used internally; prefer SystemMetrics for application code.
 */
export interface SystemMetricsResult {
  /** Total number of jobs in the system */
  total_jobs: string;
  /** Jobs with SCHEDULED, QUEUED, or RUNNING status */
  active_jobs: string;
  /** Executions waiting to be processed (PENDING status) */
  queued_executions: string;
  /** Currently executing jobs (RUNNING status) */
  running_executions: string;
  /** Successfully completed executions in last 24 hours */
  completed_24h: string;
  /** Failed executions in last 24 hours */
  failed_24h: string;
}

/**
 * Parsed system metrics with numeric values.
 *
 * @description System health snapshot returned by getSystemMetrics().
 * All values are parsed from string to number for direct use.
 * Used by dashboard endpoints and monitoring.
 */
export interface SystemMetrics {
  /** Total number of jobs in the system */
  total_jobs: number;
  /** Jobs actively being scheduled or executed */
  active_jobs: number;
  /** Executions waiting in the queue */
  queued_executions: number;
  /** Executions currently being processed by workers */
  running_executions: number;
  /** Successful executions in the last 24 hours */
  completed_24h: number;
  /** Failed executions in the last 24 hours */
  failed_24h: number;
}

/**
 * Field mapping for execution updates.
 *
 * @description Maps update input keys to database column names for the
 * job_executions table. Used by updateExecution() to build dynamic UPDATE queries.
 *
 * @example
 * // Internal use in updateExecution
 * for (const [key, column] of Object.entries(EXECUTION_FIELD_MAP)) {
 *   if (key in updates) {
 *     updateFields.push(`${column} = $${paramIndex}`);
 *   }
 * }
 */
export const EXECUTION_FIELD_MAP: Record<string, string> = {
  status: 'status',
  attempt: 'attempt',
  started_at: 'started_at',
  completed_at: 'completed_at',
  next_retry_at: 'next_retry_at',
  result: 'result',
  error: 'error',
  worker_id: 'worker_id',
};
