/**
 * Repository module combining all database operations.
 *
 * @description Central export point for all database repository functions.
 * Re-exports all functions from job, execution, and schedule repositories
 * for convenient single-import access.
 *
 * Import from this file for a unified API, or import directly from specific
 * modules (job-repository, execution-repository, schedule-repository) for
 * more granular control and smaller bundle sizes.
 *
 * @module db/repository
 *
 * @example
 * // Unified import
 * import { createJob, createExecution, getDueJobs } from './db/repository';
 *
 * @example
 * // Granular import (smaller bundles)
 * import { createJob } from './db/job-repository';
 * import { createExecution } from './db/execution-repository';
 */

// Re-export all job operations
export {
  createJob,
  getJob,
  getJobByName,
  listJobs,
  listJobsWithStats,
  updateJob,
  deleteJob,
  updateJobStatus,
} from './job-repository';

// Re-export all schedule operations
export {
  getDueJobs,
  scheduleNextRun,
  pauseJob,
  resumeJob,
} from './schedule-repository';

// Re-export all execution operations
export {
  createExecution,
  getExecution,
  getExecutionWithJob,
  listExecutions,
  updateExecution,
  getRetryableExecutions,
  addExecutionLog,
  getExecutionLogs,
} from './execution-repository';

// Re-export query helpers and metrics
export {
  getSystemMetrics,
  getExecutionStats,
  buildWhereClause,
  calculateOffset,
  getCount,
} from './queries';

// Re-export types for convenience
export type {
  Job,
  JobExecution,
  JobWithStats,
  ExecutionLog,
  PaginatedResponse,
  SystemMetrics,
  HourlyStats,
  CountResult,
} from './types';
