import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction } from './pool';
import {
  Job,
  JobStatus,
  CreateJobInput,
  UpdateJobInput,
  JobWithStats,
  JobExecution,
  ExecutionStatus,
  ExecutionLog,
  PaginatedResponse,
} from '../types';
import { logger } from '../utils/logger';
import cronParser from 'cron-parser';

// === Job Operations ===

export async function createJob(input: CreateJobInput): Promise<Job> {
  const id = uuidv4();
  let nextRunTime: Date | null = null;

  if (input.schedule) {
    // Parse cron expression to get next run time
    try {
      const interval = cronParser.parseExpression(input.schedule);
      nextRunTime = interval.next().toDate();
    } catch (error) {
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

export async function getJob(id: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
}

export async function getJobByName(name: string): Promise<Job | null> {
  return queryOne<Job>('SELECT * FROM jobs WHERE name = $1', [name]);
}

export async function listJobs(
  page: number = 1,
  limit: number = 20,
  status?: JobStatus
): Promise<PaginatedResponse<Job>> {
  const offset = (page - 1) * limit;
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
    query<{ count: string }>(`SELECT COUNT(*) as count FROM jobs ${status ? 'WHERE status = $1' : ''}`, status ? [status] : []),
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

export async function listJobsWithStats(
  page: number = 1,
  limit: number = 20
): Promise<PaginatedResponse<JobWithStats>> {
  const offset = (page - 1) * limit;

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

  const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM jobs', []);
  const total = parseInt(countResult[0]?.count || '0', 10);

  return {
    items: jobs,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

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
    } catch (error) {
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

export async function deleteJob(id: string): Promise<boolean> {
  const result = await query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
  if (result.length > 0) {
    logger.info(`Job deleted: ${id}`);
    return true;
  }
  return false;
}

export async function updateJobStatus(id: string, status: JobStatus): Promise<Job | null> {
  return queryOne<Job>(
    'UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
}

export async function pauseJob(id: string): Promise<Job | null> {
  return updateJobStatus(id, JobStatus.PAUSED);
}

export async function resumeJob(id: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job || job.status !== JobStatus.PAUSED) {
    return null;
  }

  // Recalculate next run time for recurring jobs
  if (job.schedule) {
    const interval = cronParser.parseExpression(job.schedule);
    const nextRunTime = interval.next().toDate();
    return queryOne<Job>(
      'UPDATE jobs SET status = $1, next_run_time = $2 WHERE id = $3 RETURNING *',
      [JobStatus.SCHEDULED, nextRunTime, id]
    );
  }

  return updateJobStatus(id, JobStatus.SCHEDULED);
}

// === Scheduler Operations ===

export async function getDueJobs(limit: number = 100): Promise<Job[]> {
  // Use FOR UPDATE SKIP LOCKED for distributed scheduling safety
  return query<Job>(
    `SELECT * FROM jobs
     WHERE status = 'SCHEDULED'
       AND next_run_time <= NOW()
       AND next_run_time > NOW() - INTERVAL '5 minutes'
     ORDER BY priority DESC, next_run_time ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
}

export async function scheduleNextRun(jobId: string): Promise<Job | null> {
  const job = await getJob(jobId);
  if (!job || !job.schedule) {
    return null;
  }

  try {
    const interval = cronParser.parseExpression(job.schedule);
    const nextRunTime = interval.next().toDate();

    return queryOne<Job>(
      'UPDATE jobs SET next_run_time = $1, status = $2 WHERE id = $3 RETURNING *',
      [nextRunTime, JobStatus.SCHEDULED, jobId]
    );
  } catch (error) {
    logger.error(`Failed to calculate next run time for job ${jobId}`, error);
    return null;
  }
}

// === Execution Operations ===

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

export async function getExecution(id: string): Promise<JobExecution | null> {
  return queryOne<JobExecution>('SELECT * FROM job_executions WHERE id = $1', [id]);
}

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

export async function listExecutions(
  jobId?: string,
  page: number = 1,
  limit: number = 20,
  status?: ExecutionStatus
): Promise<PaginatedResponse<JobExecution>> {
  const offset = (page - 1) * limit;
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit, offset);
  const executions = await query<JobExecution>(
    `SELECT * FROM job_executions ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  const countParams = jobId || status ? params.slice(0, -2) : [];
  const countResult = await query<{ count: string }>(
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

export async function updateExecution(
  id: string,
  updates: Partial<Omit<JobExecution, 'id' | 'job_id' | 'created_at'>>
): Promise<JobExecution | null> {
  const updateFields: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  const fieldMap: Record<string, string> = {
    status: 'status',
    attempt: 'attempt',
    started_at: 'started_at',
    completed_at: 'completed_at',
    next_retry_at: 'next_retry_at',
    result: 'result',
    error: 'error',
    worker_id: 'worker_id',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
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

// === Execution Logs ===

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

// === Metrics ===

export async function getSystemMetrics(): Promise<{
  total_jobs: number;
  active_jobs: number;
  queued_executions: number;
  running_executions: number;
  completed_24h: number;
  failed_24h: number;
}> {
  const result = await queryOne<{
    total_jobs: string;
    active_jobs: string;
    queued_executions: string;
    running_executions: string;
    completed_24h: string;
    failed_24h: string;
  }>(`
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

export async function getExecutionStats(
  hours: number = 24
): Promise<
  Array<{
    hour: Date;
    completed: number;
    failed: number;
    avg_duration_ms: number;
  }>
> {
  return query<{
    hour: Date;
    completed: number;
    failed: number;
    avg_duration_ms: number;
  }>(
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
