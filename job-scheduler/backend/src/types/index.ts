// Job status enum
export enum JobStatus {
  SCHEDULED = 'SCHEDULED',
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// Execution status enum
export enum ExecutionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PENDING_RETRY = 'PENDING_RETRY',
  CANCELLED = 'CANCELLED',
  DEDUPLICATED = 'DEDUPLICATED',
}

// Priority levels
export enum Priority {
  LOW = 25,
  NORMAL = 50,
  HIGH = 75,
  CRITICAL = 100,
}

// Job definition
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

// Job creation input
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

// Job update input
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

// Job execution record
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

// Queue item
export interface QueueItem {
  execution_id: string;
  job_id: string;
  priority: number;
  enqueued_at: number;
}

// Worker info
export interface WorkerInfo {
  id: string;
  status: 'idle' | 'busy';
  current_execution_id: string | null;
  last_heartbeat: Date;
  jobs_completed: number;
  jobs_failed: number;
}

// System metrics
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

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Pagination
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// Job with execution stats
export interface JobWithStats extends Job {
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  last_execution_at: Date | null;
  avg_duration_ms: number | null;
}

// Execution log entry
export interface ExecutionLog {
  id: string;
  execution_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}
