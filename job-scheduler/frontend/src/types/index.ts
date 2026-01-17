// Types shared with backend
export enum JobStatus {
  SCHEDULED = 'SCHEDULED',
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum ExecutionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PENDING_RETRY = 'PENDING_RETRY',
  CANCELLED = 'CANCELLED',
  DEDUPLICATED = 'DEDUPLICATED',
}

export interface Job {
  id: string;
  name: string;
  description: string | null;
  handler: string;
  payload: Record<string, unknown>;
  schedule: string | null;
  next_run_time: string | null;
  priority: number;
  max_retries: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  timeout_ms: number;
  status: JobStatus;
  created_at: string;
  updated_at: string;
}

export interface JobWithStats extends Job {
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  last_execution_at: string | null;
  avg_duration_ms: number | null;
}

export interface JobExecution {
  id: string;
  job_id: string;
  status: ExecutionStatus;
  attempt: number;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_retry_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  worker_id: string | null;
  created_at: string;
  logs?: ExecutionLog[];
}

export interface ExecutionLog {
  id: string;
  execution_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateJobInput {
  name: string;
  description?: string;
  handler: string;
  payload?: Record<string, unknown>;
  schedule?: string;
  scheduled_at?: string;
  priority?: number;
  max_retries?: number;
  initial_backoff_ms?: number;
  max_backoff_ms?: number;
  timeout_ms?: number;
}

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

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface SystemMetrics {
  jobs: {
    total_jobs: number;
    active_jobs: number;
    queued_executions: number;
    running_executions: number;
    completed_24h: number;
    failed_24h: number;
  };
  queue: {
    queued: number;
    processing: number;
    deadLetter: number;
  };
  workers: {
    active: number;
    total: number;
  };
}

export interface Worker {
  id: string;
  status: 'idle' | 'busy' | 'active';
  active_jobs?: number;
  jobs_completed: number;
  jobs_failed: number;
  last_heartbeat: string;
  started_at?: string;
}

export interface ExecutionStats {
  hour: string;
  completed: number;
  failed: number;
  avg_duration_ms: number | null;
}
