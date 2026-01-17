/**
 * Job status enum representing the lifecycle state of a job.
 * Jobs transition through these states as they are scheduled, executed, and completed.
 */
export enum JobStatus {
  SCHEDULED = 'SCHEDULED',
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Execution status enum representing the state of a single job execution attempt.
 * An execution is one run of a job, which may be retried multiple times.
 */
export enum ExecutionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PENDING_RETRY = 'PENDING_RETRY',
  CANCELLED = 'CANCELLED',
  DEDUPLICATED = 'DEDUPLICATED',
}

/**
 * Priority levels for job scheduling.
 * Higher priority jobs are dequeued and executed before lower priority ones.
 */
export enum Priority {
  LOW = 25,
  NORMAL = 50,
  HIGH = 75,
  CRITICAL = 100,
}

/**
 * Job definition representing a schedulable unit of work.
 * Jobs can be one-time or recurring (via cron schedule).
 */
export interface Job {
  id: string;
  name: string;
  description: string | null;
  handler: string;
  payload: Record<string, unknown>;
  schedule: string | null; // Cron expression
  next_run_time: Date | null;
  priority: number;
  max_retries: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  timeout_ms: number;
  status: JobStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * Input for creating a new job.
 * Only name and handler are required; other fields have sensible defaults.
 */
export interface CreateJobInput {
  name: string;
  description?: string;
  handler: string;
  payload?: Record<string, unknown>;
  schedule?: string;
  scheduled_at?: Date; // For one-time jobs
  priority?: number;
  max_retries?: number;
  initial_backoff_ms?: number;
  max_backoff_ms?: number;
  timeout_ms?: number;
}

/**
 * Input for updating an existing job.
 * All fields are optional; only provided fields will be updated.
 */
export interface UpdateJobInput {
  name?: string;
  description?: string;
  handler?: string;
  payload?: Record<string, unknown>;
  schedule?: string;
  priority?: number;
  max_retries?: number;
  initial_backoff_ms?: number;
  max_backoff_ms?: number;
  timeout_ms?: number;
}

/**
 * Record of a single job execution attempt.
 * Tracks timing, status, results, and the worker that processed it.
 */
export interface JobExecution {
  id: string;
  job_id: string;
  status: ExecutionStatus;
  attempt: number;
  scheduled_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  next_retry_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  worker_id: string | null;
  created_at: Date;
}

/**
 * Item in the Redis priority queue awaiting worker pickup.
 * Used internally by the reliable queue implementation.
 */
export interface QueueItem {
  execution_id: string;
  job_id: string;
  priority: number;
  enqueued_at: number;
}

/**
 * Information about a worker process.
 * Workers poll the queue and execute jobs; this tracks their health and stats.
 */
export interface WorkerInfo {
  id: string;
  status: 'idle' | 'busy';
  current_execution_id: string | null;
  last_heartbeat: Date;
  jobs_completed: number;
  jobs_failed: number;
}

/**
 * Aggregated system metrics for monitoring and dashboard display.
 * Combines job, execution, queue, and worker statistics.
 */
export interface SystemMetrics {
  total_jobs: number;
  active_jobs: number;
  queued_executions: number;
  running_executions: number;
  completed_executions_24h: number;
  failed_executions_24h: number;
  active_workers: number;
  scheduler_is_leader: boolean;
}

/**
 * Standard API response wrapper for consistent frontend handling.
 * All API endpoints return data in this format.
 * @template T - The type of data in the response
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Paginated response for list endpoints.
 * Includes metadata for client-side pagination controls.
 * @template T - The type of items in the list
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

/**
 * Job with aggregated execution statistics.
 * Used in job list views to show success/failure rates without extra queries.
 */
export interface JobWithStats extends Job {
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  last_execution_at: Date | null;
  avg_duration_ms: number | null;
}

/**
 * Log entry from a job execution.
 * Handlers can emit logs that are stored and displayed in the execution detail view.
 */
export interface ExecutionLog {
  id: string;
  execution_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}
