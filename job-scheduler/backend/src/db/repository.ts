/**
 * Repository module combining all database operations.
 *
 * @description Central export point for all database repository functions.
 * Re-exports all functions from the job, execution, schedule and execution-queue
 * modules for convenient single-import access.
 *
 * Import from this file for a unified API, or import directly from specific
 * modules (job-repository, execution-repository, schedule-repository) for
 * more granular control and smaller bundle sizes.
 *
 * @module db/repository
 *
 * @example
 * // Unified import
 * import { createJob, claimExecutions, fireDueJobs } from './db/repository';
 *
 * @example
 * // Granular import
 * import { createJob } from './db/job-repository';
 * import { claimExecutions } from './db/execution-queue';
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
} from './job-repository';

// Re-export all schedule operations
export {
  fireDueJobs,
  pauseJob,
  resumeJob,
} from './schedule-repository';
export type { FiringSummary, FiredSlot } from './schedule-repository';

// Re-export all execution operations
export {
  getExecution,
  listExecutions,
  addExecutionLog,
  getExecutionLogs,
} from './execution-repository';

// Re-export the execution queue (claim, lease, fenced outcome writes, reaper)
export {
  claimExecutions,
  renewLeases,
  completeExecution,
  failExecution,
  releaseExecution,
  reapExpiredLeases,
  enqueueManualRun,
  redriveExecution,
  cancelExecution,
  getQueueStats,
  listDeadLetter,
} from './execution-queue';
export type {
  ClaimedExecution,
  LeaseRef,
  FailureOutcome,
  ReapedLease,
  RedriveResult,
  QueueStats,
  DeadLetterItem,
} from './execution-queue';

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
